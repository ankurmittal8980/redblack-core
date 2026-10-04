import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction, closeDatabase } from './db.js';
import { communications, calling } from './providers.js';
import { AIGateway } from './ai-gateway.js';
import { CommunicationGateway } from './communication-gateway.js';
import { evaluateAutomationCondition } from './automation-graph.js';
const communicationGateway = new CommunicationGateway({ db: pool, registry: communications, callingRegistry: calling });
const aiGateway = new AIGateway({ db: pool });

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function claimRun() {
  return transaction(pool, async client => {
    const selected = await client.query(
      `SELECT id, workspace_id, automation_id, version_id, lead_id, attempt_count, metadata
         FROM automation_runs
        WHERE (status='queued' AND COALESCE(resume_at, retry_after, created_at) <= now())
           OR (status='running' AND started_at < now() - interval '10 minutes')
        ORDER BY COALESCE(retry_after, created_at), id
        LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    const run = selected.rows[0];
    if (!run) return null;
    const claimed = await client.query(
      `UPDATE automation_runs SET status='running', started_at=now(), attempt_count=attempt_count+1, retry_after=NULL
        WHERE id=$1 RETURNING *`, [run.id]
    );
    const version = await client.query(
      'SELECT definition FROM automation_versions WHERE workspace_id=$1 AND automation_id=$2 AND id=$3',
      [run.workspace_id, run.automation_id, run.version_id]
    );
    if (!version.rows[0]) throw new Error('Automation version is missing.');
    return { ...claimed.rows[0], definition: version.rows[0].definition };
  });
}

function matchesTrigger(config, event, context) {
  if (config.pipelineId && config.pipelineId !== event.pipelineId) return false;
  if (config.fromStageId && config.fromStageId !== event.fromStageId) return false;
  if (config.toStageId && config.toStageId !== event.stageId) return false;
  if (config.status && config.status !== (event.status ?? context.lead?.status)) return false;
  if (config.all || config.any || (config.field && config.operator)) {
    return evaluateAutomationCondition(config, context);
  }
  return true;
}

async function enqueueStageAutomations(client, run, { pipelineId, fromStageId, stageId }) {
  const leadResult = await client.query(
    'SELECT * FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
    [run.workspace_id, run.lead_id]
  );
  const row = leadResult.rows[0];
  if (!row) return;
  const customRows = await client.query(
    `SELECT d.field_key,v.value FROM lead_custom_fields v
       JOIN custom_field_definitions d ON d.id=v.field_definition_id
      WHERE d.workspace_id=$1 AND v.lead_id=$2`,
    [run.workspace_id, run.lead_id]
  );
  const custom = Object.fromEntries(customRows.rows.map(item => [item.field_key, item.value]));
  const lead = {
    ...row,
    custom,
    ownerId: row.owner_user_id,
    sourceId: row.source_id,
    opportunityType: row.opportunity_type,
    brandProject: row.brand_project,
    score: Number(row.score),
    budget: row.budget == null ? null : Number(row.budget)
  };
  const event = { pipelineId, fromStageId, stageId, toStageId: stageId, status: row.status };
  const context = { ...lead, ...event, lead, event };
  const candidates = await client.query(
    `SELECT id, current_version_id, trigger_config FROM automations
      WHERE workspace_id=$1 AND active=true AND trigger_type='lead.stage_changed'`, [run.workspace_id]
  );
  for (const item of candidates.rows) {
    if (!matchesTrigger(item.trigger_config ?? {}, event, context)) continue;
    await client.query(
      `INSERT INTO automation_runs(workspace_id, automation_id, version_id, lead_id, status, idempotency_key, metadata)
       VALUES($1,$2,$3,$4,'queued',$5,$6::jsonb) ON CONFLICT(automation_id,idempotency_key) DO NOTHING`,
      [run.workspace_id, item.id, item.current_version_id, run.lead_id, `event:automation-stage:${run.id}:${stageId}`, JSON.stringify({ requestedBy: null, sourceRunId: run.id, eventData: event })]
    );
  }
}

async function executeAction(run, action, position, nodeId = null) {
  if (!run.lead_id && !run.metadata?.test && action.type !== 'invoke_ai') throw new Error('This action requires a lead-linked automation run.');
  const config = action.config ?? {};
  if (run.metadata?.test) {
    return transaction(pool, async client => {
      await client.query(`INSERT INTO automation_action_runs(workspace_id,automation_run_id,version_id,position,status) VALUES($1,$2,$3,$4,'pending') ON CONFLICT(automation_run_id,position) DO NOTHING`, [run.workspace_id,run.id,run.version_id,position]);
      const prior=await client.query('SELECT status FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3 FOR UPDATE',[run.workspace_id,run.id,position]);
      if(prior.rows[0]?.status==='completed')return { skipped:true,dryRun:true };
      const result={nodeId,actionType:action.type,dryRun:true,message:'Test run recorded this action without applying changes or contacting a provider.'};
      await client.query(`UPDATE automation_action_runs SET status='completed',result=$4::jsonb,completed_at=now() WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3`,[run.workspace_id,run.id,position,JSON.stringify(result)]);
      return { completed:true,skipped:true,dryRun:true };
    });
  }
  return transaction(pool, async client => {
    await client.query(
      `INSERT INTO automation_action_runs(workspace_id, automation_run_id, version_id, position, status)
       VALUES($1,$2,$3,$4,'pending') ON CONFLICT(automation_run_id,position) DO NOTHING`,
      [run.workspace_id, run.id, run.version_id, position]
    );
    const prior = await client.query('SELECT status FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3 FOR UPDATE', [run.workspace_id, run.id, position]);
    if (prior.rows[0]?.status === 'completed') return { skipped: true };
    await client.query("UPDATE automation_action_runs SET status='pending', result='{}'::jsonb WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3", [run.workspace_id, run.id, position]);
    let result = {};
    if (action.type === 'wait') {
      await client.query("UPDATE automation_runs SET status='queued', resume_at=now()+($2::text || ' minutes')::interval WHERE id=$1", [run.id, String(config.minutes ?? 0)]);
      result = { resumedAt: `in ${config.minutes ?? 0} minutes` };
    } else if (action.type === 'create_task') {
      const owner = config.assignTo === 'owner' ? await client.query("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND role='owner' AND active=true ORDER BY joined_at LIMIT 1", [run.workspace_id]) : null;
      const assignedTo = owner?.rows[0]?.user_id ?? run.metadata?.requestedBy ?? null;
      const task = await client.query(
        `INSERT INTO tasks(workspace_id, lead_id, assigned_to, created_by, title, description, due_at, status, priority, source, task_type)
         SELECT $1,$2,$3,$4,$5,$6,now()+($7::text || ' minutes')::interval,'pending',0,'automation','follow_up'
         WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation' AND title=$5 AND status IN ('pending','in_progress'))
         ON CONFLICT DO NOTHING RETURNING id`,
        [run.workspace_id, run.lead_id, assignedTo, run.metadata?.requestedBy ?? null, config.title, config.description ?? null, String(config.dueInMinutes ?? 0)]
      );
      result = { taskId: task.rows[0]?.id ?? null, duplicate: !task.rows[0] };
    } else if (action.type === 'create_activity') {
      const activity = await client.query(
        `INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, metadata)
         VALUES($1,$2,$3,'system',$4,$5,$6::jsonb) RETURNING id`,
        [run.workspace_id, run.lead_id, run.metadata?.requestedBy ?? null, config.title, config.body ?? null, JSON.stringify({ automationRunId: run.id, actionPosition: position })]
      );
      result = { activityId: activity.rows[0].id };
    } else if (action.type === 'create_note') {
      const note = await client.query(
        `INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, metadata)
         VALUES($1,$2,$3,'note',$4,$5,$6::jsonb) RETURNING id`,
        [run.workspace_id, run.lead_id, run.metadata?.requestedBy ?? null, config.title, config.body ?? null, JSON.stringify({ automationRunId: run.id, actionPosition: position })]
      );
      result = { activityId: note.rows[0].id };
    } else if (action.type === 'schedule_follow_up') {
      const task = await client.query(
        `INSERT INTO tasks(workspace_id, lead_id, assigned_to, created_by, title, due_at, status, priority, source, task_type)
         SELECT $1,$2,COALESCE(l.owner_user_id,$3),$3,$4,now()+($5::text || ' minutes')::interval,'pending',0,'automation','follow_up'
           FROM leads l WHERE l.workspace_id=$1 AND l.id=$2 AND l.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation' AND title=$4 AND status IN ('pending','in_progress'))
         ON CONFLICT DO NOTHING RETURNING id`,
        [run.workspace_id, run.lead_id, run.metadata?.requestedBy ?? null, config.title, String(config.dueInMinutes ?? 60)]
      );
      result = { taskId: task.rows[0]?.id ?? null, duplicate: !task.rows[0] };
    } else if (action.type === 'assign_owner') {
      let ownerId = config.userId ?? null;
      if (!ownerId) {
        const candidate = await client.query(`SELECT wm.user_id,COUNT(a.id)::int AS load FROM workspace_members wm
          LEFT JOIN lead_assignments a ON a.workspace_id=wm.workspace_id AND a.user_id=wm.user_id AND a.unassigned_at IS NULL
          WHERE wm.workspace_id=$1 AND wm.active=true AND wm.role IN ('agent','manager')
          GROUP BY wm.user_id ORDER BY load,wm.user_id LIMIT 1`, [run.workspace_id]);
        ownerId = candidate.rows[0]?.user_id ?? null;
      }
      if (!ownerId) {
        const owner = await client.query("SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND active=true AND role='owner' ORDER BY joined_at LIMIT 1", [run.workspace_id]);
        ownerId = owner.rows[0]?.user_id ?? null;
      }
      if (!ownerId) throw new Error('No active workspace member is available for assignment.');
      const member = await client.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true', [run.workspace_id, ownerId]);
      if (!member.rows[0]) throw new Error('Automation owner is not an active workspace member.');
      const existing = await client.query('SELECT user_id FROM lead_assignments WHERE workspace_id=$1 AND lead_id=$2 AND unassigned_at IS NULL FOR UPDATE', [run.workspace_id, run.lead_id]);
      if (existing.rows[0]?.user_id !== ownerId) {
        await client.query('UPDATE lead_assignments SET unassigned_at=now() WHERE workspace_id=$1 AND lead_id=$2 AND unassigned_at IS NULL', [run.workspace_id, run.lead_id]);
        await client.query('INSERT INTO lead_assignments(workspace_id,lead_id,user_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5)', [run.workspace_id, run.lead_id, ownerId, run.metadata?.requestedBy ?? null, 'Automation assignment']);
        await client.query('UPDATE leads SET owner_user_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [run.workspace_id, run.lead_id, ownerId]);
      }
      result = { ownerId, unchanged: existing.rows[0]?.user_id === ownerId };
    } else if (action.type === 'update_lead') {
      const values = [run.workspace_id, run.lead_id]; const sets = [];
      if (config.status !== undefined) { values.push(String(config.status).slice(0, 80)); sets.push(`status=$${values.length}`); }
      if (config.temperature !== undefined) {
        const temperature = config.temperature === null ? null : String(config.temperature).toLowerCase();
        if (temperature !== null && !['hot','warm','cold'].includes(temperature)) throw new Error('Automation temperature must be hot, warm or cold.');
        values.push(temperature); sets.push(`temperature=$${values.length}`);
      }
      if (config.score !== undefined) {
        const score = Number(config.score); if (!Number.isFinite(score) || score < 0) throw new Error('Automation score must be a non-negative number.');
        values.push(Math.trunc(score)); sets.push(`score=$${values.length}`);
      }
      if (config.nextAction !== undefined) { values.push(config.nextAction === null ? null : String(config.nextAction).slice(0, 500)); sets.push(`next_action=$${values.length}`); }
      if (config.nextActionAt !== undefined) {
        let nextActionAt = null;
        if (config.nextActionAt) { const parsed = new Date(config.nextActionAt); if (Number.isNaN(parsed.getTime())) throw new Error('Automation nextActionAt must be a valid date.'); nextActionAt = parsed.toISOString(); }
        values.push(nextActionAt); sets.push(`next_action_at=$${values.length}`);
      }
      if (config.doNotContact !== undefined) { if (typeof config.doNotContact !== 'boolean') throw new Error('Automation doNotContact must be boolean.'); values.push(config.doNotContact); sets.push(`do_not_contact=$${values.length}`); }
      if (config.notes !== undefined) { values.push(config.notes === null ? null : String(config.notes).slice(0, 10000)); sets.push(`notes=$${values.length}`); }
      if (!sets.length) throw new Error('Automation update_lead has no supported fields.');
      const updated = await client.query(`UPDATE leads SET ${sets.join(', ')},updated_at=now() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`, values);
      if (!updated.rows[0]) throw new Error('Lead is missing or archived.');
      result = { leadId: updated.rows[0].id, fields: sets.map(item => item.split('=')[0]) };
    } else if (action.type === 'change_stage') {
      const stage = await client.query(
        `SELECT p.id AS pipeline_id, s.id AS stage_id, s.name AS stage_name FROM pipelines p JOIN pipeline_stages s ON s.pipeline_id=p.id
         WHERE p.workspace_id=$1 AND p.id=$2 AND s.id=$3 AND p.active=true`,
        [run.workspace_id, config.pipelineId, config.stageId]
      );
      if (!stage.rows[0]) throw new Error('Automation stage no longer exists in its workspace pipeline.');
      const current = await client.query('SELECT current_stage_id FROM lead_pipeline_entries WHERE workspace_id=$1 AND lead_id=$2 AND pipeline_id=$3 AND is_current=true FOR UPDATE', [run.workspace_id, run.lead_id, config.pipelineId]);
      if (current.rows[0]?.current_stage_id !== config.stageId) {
        await client.query('UPDATE lead_pipeline_entries SET is_current=false, exited_at=now() WHERE workspace_id=$1 AND lead_id=$2 AND pipeline_id=$3 AND is_current=true', [run.workspace_id, run.lead_id, config.pipelineId]);
        await client.query('INSERT INTO lead_pipeline_entries(workspace_id,lead_id,pipeline_id,current_stage_id) VALUES($1,$2,$3,$4)', [run.workspace_id, run.lead_id, config.pipelineId, config.stageId]);
        const history = await client.query('INSERT INTO lead_stage_history(workspace_id,lead_id,pipeline_id,from_stage_id,to_stage_id,changed_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id', [run.workspace_id, run.lead_id, config.pipelineId, current.rows[0]?.current_stage_id ?? null, config.stageId, run.metadata?.requestedBy ?? null, JSON.stringify({ automationRunId: run.id })]);
        await client.query('UPDATE leads SET status=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2', [run.workspace_id, run.lead_id, stage.rows[0].stage_name]);
        await enqueueStageAutomations(client, run, { pipelineId: config.pipelineId, fromStageId: current.rows[0]?.current_stage_id ?? null, stageId: config.stageId });
        result = { stageHistoryId: history.rows[0].id };
      } else result = { unchanged: true };
    } else if (action.type === 'create_message_draft') {
      const lead = await client.query('SELECT do_not_contact FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [run.workspace_id, run.lead_id]);
      if (!lead.rows[0]) throw new Error('Lead is missing or archived.');
      const message = await client.query(
        `INSERT INTO messages(workspace_id,lead_id,channel,direction,status,subject,body,idempotency_key,metadata)
         VALUES($1,$2,$3,'outbound','draft',$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
        [run.workspace_id, run.lead_id, config.channel, config.subject ?? null, config.body, `automation:${run.id}:${position}`, JSON.stringify({ automationRunId: run.id, suppressed: lead.rows[0].do_not_contact })]
      );
      result = { messageId: message.rows[0]?.id ?? null, draftOnly: true, suppressed: lead.rows[0].do_not_contact };
    } else if (action.type === 'start_call') {
      const started = await communicationGateway.startCall({ workspaceId: run.workspace_id, leadId: run.lead_id, provider: config.provider, direction: config.direction ?? 'outbound', to: config.to, isAi: config.isAi ?? false, idempotencyKey: `automation:${run.id}:${position}`, metadata: { automationRunId: run.id } });
      result = { callId: started.call.id, duplicate: started.duplicate };
    } else if (action.type === 'invoke_ai') {
      const response = await aiGateway.complete({ workspaceId: run.workspace_id, messages: config.messages ?? [{ role: 'user', content: config.prompt ?? '' }], model: config.model ?? null, processing: config.processing ?? 'standard', idempotencyKey: `automation:${run.id}:${position}`, toolCalls: Boolean(config.toolCalls) });
      result = { provider: response.provider, model: response.model, text: response.text, usage: response.usage };
    } else if (action.type === 'send_communication') {
      const sent = await communicationGateway.send({ workspaceId: run.workspace_id, leadId: run.lead_id, channel: config.channel, provider: config.provider, to: config.to, subject: config.subject, body: config.body, idempotencyKey: `automation:${run.id}:${position}`, metadata: { automationRunId: run.id } });
      result = { messageId: sent.message.id, duplicate: sent.duplicate };
    } else throw new Error('Automation action type is not supported.');

    if (nodeId) result = { nodeId, ...result };
    await client.query(
      `UPDATE automation_action_runs SET status='completed', result=$4::jsonb, completed_at=now()
        WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3`,
      [run.workspace_id, run.id, position, JSON.stringify(result)]
    );
    return { completed: true, wait: action.type === 'wait' };
  });
}

async function automationGraphContext(run) {
  if (!run.lead_id) return { lead: {}, event: run.metadata?.eventData ?? {} };
  const result = await pool.query('SELECT * FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [run.workspace_id, run.lead_id]);
  const row = result.rows[0]; if (!row) throw new Error('Automation lead is missing or archived.');
  const customRows = await pool.query(`SELECT d.field_key,v.value FROM lead_custom_fields v JOIN custom_field_definitions d ON d.id=v.field_definition_id WHERE d.workspace_id=$1 AND v.lead_id=$2`, [run.workspace_id, run.lead_id]);
  const custom = Object.fromEntries(customRows.rows.map(item => [item.field_key, item.value]));
  const lead = { ...row, custom, ownerId: row.owner_user_id, sourceId: row.source_id, score: Number(row.score), budget: row.budget == null ? null : Number(row.budget) };
  return { lead, custom, event: run.metadata?.eventData ?? {} };
}

async function recordGraphCondition(run, node, position, context) {
  return transaction(pool, async client => {
    await client.query(`INSERT INTO automation_action_runs(workspace_id, automation_run_id, version_id, position, status)
      VALUES($1,$2,$3,$4,'pending') ON CONFLICT(automation_run_id,position) DO NOTHING`, [run.workspace_id, run.id, run.version_id, position]);
    const prior = await client.query('SELECT status,result FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3 FOR UPDATE', [run.workspace_id, run.id, position]);
    if (prior.rows[0]?.status === 'completed') {
      const value = prior.rows[0].result;
      return value?.matched === true || value?.branch === 'yes';
    }
    const matched = evaluateAutomationCondition(node.condition, context);
    await client.query(`UPDATE automation_action_runs SET status='completed',result=$4::jsonb,completed_at=now()
      WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3`,
      [run.workspace_id, run.id, position, JSON.stringify({ nodeId: node.id, kind: 'condition', matched, branch: matched ? 'yes' : 'no', condition: node.condition })]);
    return matched;
  });
}

async function runGraph(run, graph) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const positions = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.from === node.id)]));
  let nodeId = graph.startNodeId;
  for (let count = 0; count < 100; count += 1) {
    const node = byId.get(nodeId); if (!node) throw new Error(`Automation graph references missing node ${nodeId}.`);
    if (node.type === 'end') return;
    let nextLabel = 'next';
    if (node.type === 'condition') {
      const context = await automationGraphContext(run);
      const matched = await recordGraphCondition(run, node, positions.get(node.id), context);
      nextLabel = matched ? 'yes' : 'no';
    } else {
      const action = node.type === 'wait' ? { type: 'wait', config: { minutes: node.minutes } } : node.action;
      try {
        const outcome = await executeAction(run, action, positions.get(node.id), node.id);
        if (action.type === 'wait' && !outcome?.skipped) return;
      } catch (error) {
        await pool.query(`INSERT INTO automation_action_runs(workspace_id,automation_run_id,version_id,position,status,result)
          VALUES($1,$2,$3,$4,'failed',$5::jsonb)
          ON CONFLICT(automation_run_id,position) DO UPDATE SET status='failed',result=EXCLUDED.result,completed_at=now()`,
          [run.workspace_id, run.id, run.version_id, positions.get(node.id), JSON.stringify({ nodeId: node.id, error: String(error.message).slice(0, 1000) })]);
        throw error;
      }
    }
    const edge = outgoing.get(nodeId).find(item => item.label === nextLabel);
    if (!edge) throw new Error(`Automation graph node ${nodeId} has no ${nextLabel} connection.`);
    nodeId = edge.to;
  }
  throw new Error('Automation graph exceeded the 100-step execution limit.');
}

export async function runOne(run) {
  try {
    const graph = run.definition?.graph;
    const actions = run.definition?.actions;
    if (graph) await runGraph(run, graph);
    else {
    if (!Array.isArray(actions) || actions.length > 25) throw new Error('Automation version has an invalid action list.');
    for (let index = 0; index < actions.length; index += 1) {
      let outcome;
      try { outcome = await executeAction(run, actions[index], index); }
      catch (error) {
        await pool.query(
          `INSERT INTO automation_action_runs(workspace_id, automation_run_id, version_id, position, status, result)
           VALUES($1,$2,$3,$4,'failed',$5::jsonb)
           ON CONFLICT(automation_run_id,position) DO UPDATE SET status='failed', result=EXCLUDED.result, completed_at=now()`,
          [run.workspace_id, run.id, run.version_id, index, JSON.stringify({ error: String(error.message).slice(0, 1000) })]
        );
        throw error;
      }
      if (actions[index].type === 'wait' && !outcome?.skipped) return;
    }
    }
    await pool.query("UPDATE automation_runs SET status='completed', completed_at=now(), error_message=NULL WHERE id=$1 AND status='running'", [run.id]);
  } catch (error) {
    const failureCount = Math.max(0, Number(run.metadata?.failureCount ?? 0)) + 1;
    const retryable = failureCount < 3;
    const backoffSeconds = Math.min(300, 2 ** (failureCount - 1));
    await pool.query(
      `UPDATE automation_runs SET status=$2::automation_run_status, error_message=$3,
          completed_at=CASE WHEN $6::boolean THEN now() ELSE NULL END,
          retry_after=CASE WHEN $7::boolean THEN now()+($4::text || ' seconds')::interval ELSE NULL END,
          metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{failureCount}',to_jsonb($5::int),true)
        WHERE id=$1`,
      [run.id, retryable ? 'queued' : 'failed', String(error.message).slice(0, 1000), String(backoffSeconds), failureCount, !retryable, retryable]
    );
    process.stderr.write(JSON.stringify({ level: 'error', automationRunId: run.id, code: error.code ?? null, message: error.message }) + '\n');
  }
}

async function enqueueNoResponseRuns() {
  await transaction(pool, async client => {
    const candidates = await client.query(`SELECT l.workspace_id, l.id AS lead_id, a.id AS automation_id, a.current_version_id
      FROM leads l JOIN automations a ON a.workspace_id=l.workspace_id AND a.trigger_type='lead.no_response' AND a.active=true
      WHERE l.deleted_at IS NULL AND l.updated_at < now() - interval '24 hours'`);
    for (const item of candidates.rows) {
      await client.query(`INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata)
        VALUES($1,$2,$3,$4,'queued',$5,'{"requestedBy":null,"scheduled":true}'::jsonb) ON CONFLICT(automation_id,idempotency_key) DO NOTHING`, [item.workspace_id, item.automation_id, item.current_version_id, item.lead_id, `scheduled:no-response:${item.lead_id}:${new Date().toISOString().slice(0,10)}`]);
    }
  });
}

export async function startWorker() {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    try {
      const run = await claimRun();
      if (run) await runOne(run);
      else { await enqueueNoResponseRuns(); await sleep(1000); }
    } catch (error) {
      process.stderr.write(JSON.stringify({ level: 'error', worker: 'automation', message: error.message }) + '\n');
      await sleep(2000);
    }
  }
  await closeDatabase();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startWorker();

