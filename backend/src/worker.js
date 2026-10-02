import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, transaction, closeDatabase } from './db.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function claimRun() {
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

function matchesTrigger(config, event) {
  if (config.pipelineId && config.pipelineId !== event.pipelineId) return false;
  if (config.fromStageId && config.fromStageId !== event.fromStageId) return false;
  if (config.toStageId && config.toStageId !== event.stageId) return false;
  if (config.status && config.status !== event.status) return false;
  return true;
}

async function enqueueStageAutomations(client, run, { pipelineId, fromStageId, stageId }) {
  const candidates = await client.query(
    `SELECT id, current_version_id, trigger_config FROM automations
      WHERE workspace_id=$1 AND active=true AND trigger_type='lead.stage_changed'`, [run.workspace_id]
  );
  for (const item of candidates.rows) {
    if (!matchesTrigger(item.trigger_config ?? {}, { pipelineId, fromStageId, stageId })) continue;
    await client.query(
      `INSERT INTO automation_runs(workspace_id, automation_id, version_id, lead_id, status, idempotency_key, metadata)
       VALUES($1,$2,$3,$4,'queued',$5,$6::jsonb) ON CONFLICT(automation_id,idempotency_key) DO NOTHING`,
      [run.workspace_id, item.id, item.current_version_id, run.lead_id, `event:automation-stage:${run.id}:${stageId}`, JSON.stringify({ requestedBy: null, sourceRunId: run.id })]
    );
  }
}

async function executeAction(run, action, position) {
  if (!run.lead_id) throw new Error('This action requires a lead-linked automation run.');
  const config = action.config ?? {};
  await transaction(pool, async client => {
    await client.query(
      `INSERT INTO automation_action_runs(workspace_id, automation_run_id, version_id, position, status)
       VALUES($1,$2,$3,$4,'pending') ON CONFLICT(automation_run_id,position) DO NOTHING`,
      [run.workspace_id, run.id, run.version_id, position]
    );
    const prior = await client.query('SELECT status FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3 FOR UPDATE', [run.workspace_id, run.id, position]);
    if (prior.rows[0]?.status === 'completed') return;
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
         WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation' AND title=$5 AND status IN ('pending','in_progress')) RETURNING id`,
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
    } else throw new Error('Automation action type is not supported.');

    await client.query(
      `UPDATE automation_action_runs SET status='completed', result=$4::jsonb, completed_at=now()
        WHERE workspace_id=$1 AND automation_run_id=$2 AND position=$3`,
      [run.workspace_id, run.id, position, JSON.stringify(result)]
    );
  });
}

async function runOne(run) {
  try {
    const actions = run.definition?.actions;
    if (!Array.isArray(actions) || actions.length > 25) throw new Error('Automation version has an invalid action list.');
    for (let index = 0; index < actions.length; index += 1) {
      try { await executeAction(run, actions[index], index); }
      catch (error) {
        await pool.query(
          `INSERT INTO automation_action_runs(workspace_id, automation_run_id, version_id, position, status, result)
           VALUES($1,$2,$3,$4,'failed',$5::jsonb)
           ON CONFLICT(automation_run_id,position) DO UPDATE SET status='failed', result=EXCLUDED.result, completed_at=now()`,
          [run.workspace_id, run.id, run.version_id, index, JSON.stringify({ error: String(error.message).slice(0, 1000) })]
        );
        throw error;
      }
      if (actions[index].type === 'wait') return;
    }
    await pool.query("UPDATE automation_runs SET status='completed', completed_at=now(), error_message=NULL WHERE id=$1 AND status='running'", [run.id]);
  } catch (error) {
    const retryable = Number(run.attempt_count) < 3;
    const backoffSeconds = Math.min(300, 2 ** Number(run.attempt_count));
    await pool.query(
      `UPDATE automation_runs SET status=$2, error_message=$3, completed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,
          retry_after=CASE WHEN $2='queued' THEN now()+($4::text || ' seconds')::interval ELSE NULL END
        WHERE id=$1`,
      [run.id, retryable ? 'queued' : 'failed', String(error.message).slice(0, 1000), String(backoffSeconds)]
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

