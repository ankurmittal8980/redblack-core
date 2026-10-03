import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL migrations apply idempotently and install tenant/security controls', { skip: !databaseUrl }, async () => {
  const [{ Pool }, { applyMigrations }] = await Promise.all([import('pg'), import('../backend/src/migrate.js')]);
  const db = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(db);
    await applyMigrations(db);
    const migrations = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map(row => row.version), ['0001_redblack_crm_core.sql', '0002_security_idempotency_and_operations.sql', '0003_automation_parity.sql', '0004_automation_default_backfill.sql', '0005_repair_automation_workspace_name_constraint.sql', '0006_communication_gateway.sql', '0007_voice_ai_call_metadata.sql', '0008_usage_budgets.sql', '0009_control_center_settings.sql',
      '0010_crm_builder_rules.sql', '0011_automation_followup_dedupe.sql']);
    const constraints = await db.query(`SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`, [[
      'leads_source_same_workspace_fk', 'lead_pipeline_entries_stage_in_pipeline_fk',
      'tasks_lead_same_workspace_fk', 'automation_runs_version_fk', 'messages_lead_same_workspace_fk'
    ]]);
    assert.equal(constraints.rowCount, 5);
    const triggers = await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`, [[
      'usage_events_append_only', 'provider_rates_append_only', 'automation_versions_append_only', 'audit_logs_append_only'
    ]]);
    assert.equal(triggers.rowCount, 4);
    const tables = await db.query(`SELECT to_regclass('auth_sessions') IS NOT NULL AS sessions,
                                         to_regclass('automation_action_runs') IS NOT NULL AS action_runs,
                                         to_regclass('provider_rates') IS NOT NULL AS rates,
                                         to_regclass('import_batches') IS NOT NULL AS imports`);
    assert.deepEqual(tables.rows[0], { sessions: true, action_runs: true, rates: true, imports: true });

    // Simulate a pre-PR13 install where 0004 was recorded but its index was absent.
    // The forward repair migration must restore the index without resetting data.
    await db.query('DROP INDEX IF EXISTS automations_workspace_name_key');
    await db.query("DELETE FROM schema_migrations WHERE version='0005_repair_automation_workspace_name_constraint.sql'");
    await applyMigrations(db);
    const repairedIndex = await db.query("SELECT 1 FROM pg_indexes WHERE indexname='automations_workspace_name_key'");
    assert.equal(repairedIndex.rowCount, 1);
  } finally {
    await db.end();
  }
});

test('new lead event runs the default automation and creates exactly one follow-up task', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, { ensureDefaultAutomations, dispatchAutomationEvent }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/server.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const workspace = await db.query("INSERT INTO workspaces(name,slug) VALUES('Automation Test','automation-test') RETURNING id");
  const workspaceId = workspace.rows[0].id;
  const user = await db.query("INSERT INTO users(email,display_name) VALUES('automation-test@example.com','Automation Test') RETURNING id");
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, user.rows[0].id]);
  try {
    await ensureDefaultAutomations(db);
    const lead = await db.query("INSERT INTO leads(workspace_id,first_name,status) VALUES($1,'Test','New Lead') RETURNING id", [workspaceId]);
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.created', leadId: lead.rows[0].id, eventId: `test-lead:${lead.rows[0].id}` });
    const queued = await db.query(`SELECT r.*, v.definition FROM automation_runs r JOIN automation_versions v ON v.id=r.version_id
      WHERE r.workspace_id=$1 AND r.lead_id=$2 AND r.status='queued'`, [workspaceId, lead.rows[0].id]);
    assert.equal(queued.rowCount, 1);
    assert.equal(queued.rows[0].lead_id, lead.rows[0].id);
    await worker.runOne({ ...queued.rows[0], attempt_count: 1, definition: queued.rows[0].definition });
    const tasks = await db.query("SELECT id FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation'", [workspaceId, lead.rows[0].id]);
    assert.equal(tasks.rowCount, 1);
    const duplicate = await db.query(
      "INSERT INTO tasks(workspace_id,lead_id,assigned_to,created_by,title,status,source) VALUES($1,$2,$3,$3,'First follow-up call','pending','automation') ON CONFLICT DO NOTHING RETURNING id",
      [workspaceId, lead.rows[0].id, user.rows[0].id]
    );
    assert.equal(duplicate.rowCount, 0);

    const definition = { triggerType: 'manual', triggerConfig: {}, actions: [
      { type: 'update_lead', config: { status: 'Qualified', score: 75 } },
      { type: 'assign_owner', config: {} },
      { type: 'create_note', config: { title: 'Qualified automatically', body: 'Worker action executed.' } },
      { type: 'schedule_follow_up', config: { title: 'Call qualified lead', dueInMinutes: 60 } }
    ] };
    const automation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,'Worker CRM actions',false,'manual','{}'::jsonb,$2) RETURNING id", [workspaceId, user.rows[0].id]);
    const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), user.rows[0].id]);
    await db.query('UPDATE automations SET current_version_id=$3 WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
    const actionRun = await db.query("INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata) VALUES($1,$2,$3,$4,'running',$5,$6::jsonb) RETURNING *", [workspaceId, automation.rows[0].id, version.rows[0].id, lead.rows[0].id, `worker-actions:${lead.rows[0].id}`, JSON.stringify({ requestedBy: user.rows[0].id })]);
    await worker.runOne({ ...actionRun.rows[0], definition });
    const updatedLead = await db.query('SELECT status,score,owner_user_id FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceId, lead.rows[0].id]);
    assert.deepEqual({ status: updatedLead.rows[0].status, score: updatedLead.rows[0].score, owner: updatedLead.rows[0].owner_user_id }, { status: 'Qualified', score: 75, owner: user.rows[0].id });
    const note = await db.query("SELECT 1 FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title='Qualified automatically'", [workspaceId, lead.rows[0].id]);
    assert.equal(note.rowCount, 1);
    const followUp = await db.query("SELECT 1 FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation' AND title='Call qualified lead' AND status='pending'", [workspaceId, lead.rows[0].id]);
    assert.equal(followUp.rowCount, 1);
  } finally {
    // The migration intentionally makes automation versions append-only; this test uses an ephemeral CI database.
    await db.end();
  }
});




test('bulk CRM API enforces workspace scope and persists tenant keys', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { createRedBlackServer }, { createSession }] = await Promise.all([
    import('pg'), import('../backend/src/server.js'), import('../backend/src/auth.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceA = (await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', ['Bulk API A', `bulk-api-a-${suffix}`])).rows[0].id;
  const workspaceB = (await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', ['Bulk API B', `bulk-api-b-${suffix}`])).rows[0].id;
  const userId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`bulk-api-${suffix}@example.com`, 'Bulk API Owner'])).rows[0].id;
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceA, userId]);
  const leadA = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Workspace A Lead') RETURNING id", [workspaceA])).rows[0].id;
  const leadB = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Workspace B Lead') RETURNING id", [workspaceB])).rows[0].id;
  const oldTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'Old') RETURNING id", [workspaceA])).rows[0].id;
  const newTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'New') RETURNING id", [workspaceA])).rows[0].id;
  const foreignTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'Foreign') RETURNING id", [workspaceB])).rows[0].id;
  await db.query('INSERT INTO lead_tags(workspace_id,lead_id,tag_id) VALUES($1,$2,$3)', [workspaceA, leadA, oldTag]);
  const pipelineId = (await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Bulk','bulk') RETURNING id", [workspaceA])).rows[0].id;
  const stageId = (await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'Qualified','qualified',1) RETURNING id", [pipelineId])).rows[0].id;
  const secondStageId = (await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'Proposal','proposal',2) RETURNING id", [pipelineId])).rows[0].id;
  const requiredFieldId = (await db.query("INSERT INTO custom_field_definitions(workspace_id,entity_type,field_key,label,field_type,required,config) VALUES($1,'lead','segment','Segment','text',true,'{}'::jsonb) RETURNING id", [workspaceA])).rows[0].id;
  const meetingId = (await db.query("INSERT INTO meetings(workspace_id,lead_id,owner_user_id,starts_at,status,meeting_type) VALUES($1,$2,$3,now(),'scheduled','Test') RETURNING id", [workspaceA, leadA, userId])).rows[0].id;
  const assignmentRuleId = (await db.query("INSERT INTO crm_assignment_rules(workspace_id,name,conditions,strategy,config,active) VALUES($1,'Test assignment','{}'::jsonb,'unassigned','{}'::jsonb,true) RETURNING id", [workspaceA])).rows[0].id;
  const scoringRuleId = (await db.query("INSERT INTO crm_scoring_rules(workspace_id,name,conditions,score_delta,active) VALUES($1,'Test score','{}'::jsonb,10,true) RETURNING id", [workspaceA])).rows[0].id;
  const session = await createSession(db, { userId, workspaceId: workspaceA });
  const server = createRedBlackServer({ db });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/leads/bulk`;
  const headers = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(session.token)}; rb_csrf=${encodeURIComponent(session.csrf)}`,
    'x-csrf-token': session.csrf
  };
  const bulk = body => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    const meetingsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/meetings?limit=10`, { headers });
    assert.equal(meetingsResponse.status, 200);
    const meetingsPayload = await meetingsResponse.json();
    assert.equal(meetingsPayload.data.some(item => item.id === meetingId), true);
    const meetingsByLead = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/meetings?leadId=${leadA}&limit=10`, { headers });
    assert.equal(meetingsByLead.status, 200);

    const assignmentToggle = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/assignment-rules/${assignmentRuleId}`, { method:'PATCH', headers, body:JSON.stringify({ active:false, priority:50 }) });
    assert.equal(assignmentToggle.status, 200);
    const scoringToggle = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/scoring-rules/${scoringRuleId}`, { method:'PATCH', headers, body:JSON.stringify({ active:false, scoreDelta:25 }) });
    assert.equal(scoringToggle.status, 200);
    const ruleStates = await db.query('SELECT active,priority FROM crm_assignment_rules WHERE id=$1', [assignmentRuleId]);
    assert.deepEqual(ruleStates.rows[0], { active:false, priority:50 });
    const scoreState = await db.query('SELECT active,score_delta FROM crm_scoring_rules WHERE id=$1', [scoringRuleId]);
    assert.deepEqual(scoreState.rows[0], { active:false, score_delta:25 });

    const invalidLeadEdit = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/leads/${leadA}`, { method:'PATCH', headers, body:JSON.stringify({ status:'Should Roll Back', tagIds:[foreignTag] }) });
    assert.equal(invalidLeadEdit.status, 400);
    const rolledBackEdit = await db.query('SELECT status FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, leadA]);
    assert.equal(rolledBackEdit.rows[0].status, 'New Lead');

    const createEndpoint = `http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/leads`;
    const missingRequired = await fetch(createEndpoint, { method:'POST', headers, body:JSON.stringify({ firstName:'Missing Required' }) });
    assert.equal(missingRequired.status, 400);
    const rolledBack = await db.query("SELECT 1 FROM leads WHERE workspace_id=$1 AND first_name='Missing Required'", [workspaceA]);
    assert.equal(rolledBack.rowCount, 0);

    const createdLeadResponse = await fetch(createEndpoint, { method:'POST', headers, body:JSON.stringify({ firstName:'Configured Lead', customFields:{ [requiredFieldId]:'Enterprise' }, tagIds:[newTag] }) });
    assert.equal(createdLeadResponse.status, 201);
    const createdLead = await createdLeadResponse.json();
    const savedCustom = await db.query('SELECT workspace_id,value FROM lead_custom_fields WHERE lead_id=$1 AND field_definition_id=$2', [createdLead.id, requiredFieldId]);
    assert.equal(savedCustom.rows[0].workspace_id, workspaceA);
    assert.equal(savedCustom.rows[0].value, 'Enterprise');
    const savedTag = await db.query('SELECT workspace_id,tag_id FROM lead_tags WHERE lead_id=$1', [createdLead.id]);
    assert.deepEqual(savedTag.rows, [{ workspace_id: workspaceA, tag_id: newTag }]);

    const crossWorkspace = await bulk({ operation: 'tags', leadIds: [leadA, leadB], tagIds: [] });
    assert.equal(crossWorkspace.status, 404);
    const untouched = await db.query('SELECT tag_id FROM lead_tags WHERE workspace_id=$1 AND lead_id=$2', [workspaceA, leadA]);
    assert.deepEqual(untouched.rows.map(row => row.tag_id), [oldTag]);

    const tagged = await bulk({ operation: 'tags', leadIds: [leadA], tagIds: [newTag] });
    assert.equal(tagged.status, 200, await tagged.text());
    const tags = await db.query('SELECT workspace_id,tag_id FROM lead_tags WHERE lead_id=$1', [leadA]);
    assert.deepEqual(tags.rows, [{ workspace_id: workspaceA, tag_id: newTag }]);

    const staged = await bulk({ operation: 'stage', leadIds: [leadA], pipelineId, stageId });
    assert.equal(staged.status, 200, await staged.text());
    const history = await db.query('SELECT workspace_id,pipeline_id,to_stage_id FROM lead_stage_history WHERE lead_id=$1 ORDER BY changed_at DESC LIMIT 1', [leadA]);
    assert.deepEqual(history.rows[0], { workspace_id: workspaceA, pipeline_id: pipelineId, to_stage_id: stageId });

    const reordered = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/pipelines/${pipelineId}/stages/${stageId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ position: 2 })
    });
    assert.equal(reordered.status, 200, await reordered.text());
    const positions = await db.query('SELECT id,position FROM pipeline_stages WHERE pipeline_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [pipelineId, [stageId, secondStageId]]);
    const byId = Object.fromEntries(positions.rows.map(row => [row.id, Number(row.position)]));
    assert.equal(byId[stageId], 2);
    assert.equal(byId[secondStageId], 1);
    const stageAudit = await db.query("SELECT 1 FROM audit_logs WHERE workspace_id=$1 AND entity_id=$2 AND action='pipeline.stage_updated'", [workspaceA, stageId]);
    assert.equal(stageAudit.rowCount, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});


test('agent CRM APIs stay scoped to assigned records and self task assignment', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { createRedBlackServer }, { createSession }] = await Promise.all([
    import('pg'), import('../backend/src/server.js'), import('../backend/src/auth.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceId = (await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', ['Agent Scope', `agent-scope-${suffix}`])).rows[0].id;
  const agentId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`agent-${suffix}@example.com`, 'Scoped Agent'])).rows[0].id;
  const peerId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`peer-${suffix}@example.com`, 'Peer Agent'])).rows[0].id;
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'agent'),($1,$3,'agent')", [workspaceId, agentId, peerId]);
  const ownedLead = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Owned') RETURNING id", [workspaceId])).rows[0].id;
  const otherLead = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Other') RETURNING id", [workspaceId])).rows[0].id;
  await db.query("INSERT INTO lead_assignments(workspace_id,lead_id,user_id,assigned_by,reason) VALUES($1,$2,$3,$3,'test'),($1,$4,$5,$5,'test')", [workspaceId, ownedLead, agentId, otherLead, peerId]);
  const ownedActivity = (await db.query("INSERT INTO activities(workspace_id,lead_id,user_id,type,title) VALUES($1,$2,$3,'note','Owned activity') RETURNING id", [workspaceId, ownedLead, peerId])).rows[0].id;
  const otherActivity = (await db.query("INSERT INTO activities(workspace_id,lead_id,user_id,type,title) VALUES($1,$2,$3,'note','Other activity') RETURNING id", [workspaceId, otherLead, peerId])).rows[0].id;
  const ownUnlinkedActivity = (await db.query("INSERT INTO activities(workspace_id,user_id,type,title) VALUES($1,$2,'note','Own unlinked activity') RETURNING id", [workspaceId, agentId])).rows[0].id;
  const ownedCall = (await db.query("INSERT INTO calls(workspace_id,lead_id,user_id,direction,status) VALUES($1,$2,$3,'outbound','answered') RETURNING id", [workspaceId, ownedLead, peerId])).rows[0].id;
  const otherCall = (await db.query("INSERT INTO calls(workspace_id,lead_id,user_id,direction,status) VALUES($1,$2,$3,'outbound','answered') RETURNING id", [workspaceId, otherLead, peerId])).rows[0].id;
  await db.query("INSERT INTO meetings(workspace_id,lead_id,owner_user_id,starts_at,status) VALUES($1,$2,$3,now(),'scheduled'),($1,$4,$5,now(),'scheduled')", [workspaceId, ownedLead, agentId, otherLead, peerId]);
  const session = await createSession(db, { userId: agentId, workspaceId });
  const server = createRedBlackServer({ db });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/v1/workspaces/${workspaceId}`;
  const headers = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(session.token)}; rb_csrf=${encodeURIComponent(session.csrf)}`,
    'x-csrf-token': session.csrf
  };
  try {
    const dashboardResponse = await fetch(`${base}/reports/dashboard`, { headers });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = (await dashboardResponse.json()).summary;
    assert.equal(Number(dashboard.total_leads), 1);
    assert.equal(Number(dashboard.meetings), 1);

    const activitiesResponse = await fetch(`${base}/activities?limit=100`, { headers });
    assert.equal(activitiesResponse.status, 200);
    const activities = (await activitiesResponse.json()).data.map(item => item.id);
    assert.equal(activities.includes(ownedActivity), true);
    assert.equal(activities.includes(ownUnlinkedActivity), true);
    assert.equal(activities.includes(otherActivity), false);

    const callsResponse = await fetch(`${base}/calls?limit=100`, { headers });
    assert.equal(callsResponse.status, 200);
    const calls = (await callsResponse.json()).data.map(item => item.id);
    assert.equal(calls.includes(ownedCall), true);
    assert.equal(calls.includes(otherCall), false);

    const crossAssigneeTask = await fetch(`${base}/tasks`, {
      method: 'POST', headers, body: JSON.stringify({ leadId: ownedLead, assignedTo: peerId, title: 'Should be rejected' })
    });
    assert.equal(crossAssigneeTask.status, 403);

    const foreignCallNote = await fetch(`${base}/calls/${otherCall}/notes`, {
      method: 'POST', headers, body: JSON.stringify({ note: 'Should be rejected' })
    });
    assert.equal(foreignCallNote.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});
