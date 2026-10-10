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
      '0010_crm_builder_rules.sql', '0011_automation_followup_dedupe.sql', '0012_crm_entity_foundations.sql', '0013_crm_operational_completion.sql']);
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
  const reportingId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`bulk-reporting-${suffix}@example.com`, 'Bulk API Reporting'])).rows[0].id;
  const serviceId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`bulk-service-${suffix}@example.com`, 'Bulk API Service'])).rows[0].id;
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceA, userId]);
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'reporting')", [workspaceA, reportingId]);
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'service')", [workspaceA, serviceId]);
  const leadA = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Workspace A Lead') RETURNING id", [workspaceA])).rows[0].id;
  const leadB = (await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Workspace B Lead') RETURNING id", [workspaceB])).rows[0].id;
  const oldTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'Old') RETURNING id", [workspaceA])).rows[0].id;
  const newTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'New') RETURNING id", [workspaceA])).rows[0].id;
  const foreignTag = (await db.query("INSERT INTO tags(workspace_id,name) VALUES($1,'Foreign') RETURNING id", [workspaceB])).rows[0].id;
  const leadSourceId = (await db.query("INSERT INTO lead_sources(workspace_id,name) VALUES($1,'Web') RETURNING id", [workspaceA])).rows[0].id;
  await db.query('INSERT INTO lead_tags(workspace_id,lead_id,tag_id) VALUES($1,$2,$3)', [workspaceA, leadA, oldTag]);
  const pipelineId = (await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Bulk','bulk') RETURNING id", [workspaceA])).rows[0].id;
  const stageId = (await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'Qualified','qualified',1) RETURNING id", [pipelineId])).rows[0].id;
  const secondStageId = (await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'Proposal','proposal',2) RETURNING id", [pipelineId])).rows[0].id;
  const requiredFieldId = (await db.query("INSERT INTO custom_field_definitions(workspace_id,entity_type,field_key,label,field_type,required,config) VALUES($1,'lead','segment','Segment','text',true,'{}'::jsonb) RETURNING id", [workspaceA])).rows[0].id;
  const meetingId = (await db.query("INSERT INTO meetings(workspace_id,lead_id,owner_user_id,starts_at,status,meeting_type) VALUES($1,$2,$3,now(),'scheduled','Test') RETURNING id", [workspaceA, leadA, userId])).rows[0].id;
  const assignmentRuleId = (await db.query("INSERT INTO crm_assignment_rules(workspace_id,name,conditions,strategy,config,active) VALUES($1,'Test assignment','{}'::jsonb,'unassigned','{}'::jsonb,true) RETURNING id", [workspaceA])).rows[0].id;
  const scoringRuleId = (await db.query("INSERT INTO crm_scoring_rules(workspace_id,name,conditions,score_delta,active) VALUES($1,'Test score','{}'::jsonb,10,true) RETURNING id", [workspaceA])).rows[0].id;
  const session = await createSession(db, { userId, workspaceId: workspaceA });
  const reportingSession = await createSession(db, { userId: reportingId, workspaceId: workspaceA });
  const serviceSession = await createSession(db, { userId: serviceId, workspaceId: workspaceA });
  const server = createRedBlackServer({ db });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/v1/workspaces/${workspaceA}/leads/bulk`;
  const headers = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(session.token)}; rb_csrf=${encodeURIComponent(session.csrf)}`,
    'x-csrf-token': session.csrf
  };
  const reportingHeaders = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(reportingSession.token)}; rb_csrf=${encodeURIComponent(reportingSession.csrf)}`,
    'x-csrf-token': reportingSession.csrf
  };
  const serviceHeaders = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(serviceSession.token)}; rb_csrf=${encodeURIComponent(serviceSession.csrf)}`,
    'x-csrf-token': serviceSession.csrf
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

    const configuredEmail = `configured-${suffix}@example.com`;
    const createdLeadResponse = await fetch(createEndpoint, { method:'POST', headers, body:JSON.stringify({ firstName:'Configured Lead', email:configuredEmail, sourceId:leadSourceId, status:'New Lead', temperature:'warm', customFields:{ [requiredFieldId]:'Enterprise' }, tagIds:[newTag] }) });
    assert.equal(createdLeadResponse.status, 201);
    const createdLead = await createdLeadResponse.json();
    const duplicateLeadResponse = await fetch(createEndpoint, { method:'POST', headers, body:JSON.stringify({ firstName:'Duplicate Lead', email:configuredEmail.toUpperCase() }) });
    assert.equal(duplicateLeadResponse.status, 409);
    const savedLeadFields = await db.query('SELECT email_normalized,source_id,status,temperature FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, createdLead.id]);
    assert.deepEqual(savedLeadFields.rows[0], { email_normalized:configuredEmail, source_id:leadSourceId, status:'New Lead', temperature:'warm' });
    const savedCustom = await db.query('SELECT workspace_id,value FROM lead_custom_fields WHERE lead_id=$1 AND field_definition_id=$2', [createdLead.id, requiredFieldId]);
    assert.equal(savedCustom.rows[0].workspace_id, workspaceA);
    assert.equal(savedCustom.rows[0].value, 'Enterprise');
    const savedTag = await db.query('SELECT workspace_id,tag_id FROM lead_tags WHERE lead_id=$1', [createdLead.id]);
    assert.deepEqual(savedTag.rows, [{ workspace_id: workspaceA, tag_id: newTag }]);

    const firstPageResponse = await fetch(`${createEndpoint}?limit=1`, { headers });
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPage.data.length, 1);
    assert.equal(firstPage.data[0].id, createdLead.id);
    assert.ok(firstPage.nextCursor);
    const secondPageResponse = await fetch(`${createEndpoint}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers });
    const secondPage = await secondPageResponse.json();
    assert.equal(secondPageResponse.status, 200);
    assert.equal(secondPage.data.length, 1);
    assert.equal(secondPage.data[0].id, leadA);
    assert.ok(firstPage.data[0].created_at >= secondPage.data[0].created_at);

    const editedLeadResponse = await fetch(`${createEndpoint}/${createdLead.id}`, { method:'PATCH', headers, body:JSON.stringify({ status:'Qualified', notes:'Edited through the lead API.' }) });
    assert.equal(editedLeadResponse.status, 200, await editedLeadResponse.text());
    const editedLead = await db.query('SELECT status,notes FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, createdLead.id]);
    assert.deepEqual(editedLead.rows[0], { status:'Qualified', notes:'Edited through the lead API.' });
    const timelineResponse = await fetch(`${createEndpoint}/${createdLead.id}/timeline`, { headers });
    assert.equal(timelineResponse.status, 200);
    const timeline = await timelineResponse.json();
    assert.ok(timeline.data.some(item => item.item_type === 'activity' && item.title === 'Lead created'));

    const searchedLeadsResponse = await fetch(`${createEndpoint}?q=Configured&status=Qualified`, { headers });
    assert.equal(searchedLeadsResponse.status, 200);
    const searchedLeads = await searchedLeadsResponse.json();
    assert.deepEqual(searchedLeads.data.map(lead => lead.id), [createdLead.id]);
    const workspaceFilteredResponse = await fetch(`${createEndpoint}?q=Workspace&status=New%20Lead`, { headers });
    assert.equal(workspaceFilteredResponse.status, 200);
    const workspaceFiltered = await workspaceFilteredResponse.json();
    assert.deepEqual(workspaceFiltered.data.map(lead => lead.id), [leadA]);

    const deniedCreate = await fetch(createEndpoint, { method:'POST', headers:reportingHeaders, body:JSON.stringify({ firstName:'Reporting Must Not Create' }) });
    assert.equal(deniedCreate.status, 403);
    const deniedEdit = await fetch(`${createEndpoint}/${leadA}`, { method:'PATCH', headers:reportingHeaders, body:JSON.stringify({ status:'Reporting Must Not Edit' }) });
    assert.equal(deniedEdit.status, 403);
    const unchangedAfterDeniedEdit = await db.query('SELECT status FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, leadA]);
    assert.equal(unchangedAfterDeniedEdit.rows[0].status, 'New Lead');
    const deniedCreateRow = await db.query("SELECT 1 FROM leads WHERE workspace_id=$1 AND first_name='Reporting Must Not Create'", [workspaceA]);
    assert.equal(deniedCreateRow.rowCount, 0);
    const deniedBulk = await fetch(endpoint, { method:'POST', headers:reportingHeaders, body:JSON.stringify({ operation:'trash', leadIds:[leadA] }) });
    assert.equal(deniedBulk.status, 403);
    const reportingLeadState = await db.query('SELECT deleted_at FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, leadA]);
    assert.equal(reportingLeadState.rows[0].deleted_at, null);

    const serviceCreate = await fetch(createEndpoint, { method:'POST', headers:serviceHeaders, body:JSON.stringify({ firstName:'Service Can Write', customFields:{ [requiredFieldId]:'Enterprise' } }) });
    assert.equal(serviceCreate.status, 201);
    const serviceLead = await serviceCreate.json();
    const serviceEdit = await fetch(`${createEndpoint}/${serviceLead.id}`, { method:'PATCH', headers:serviceHeaders, body:JSON.stringify({ status:'Service Updated' }) });
    assert.equal(serviceEdit.status, 200);
    const serviceState = await db.query('SELECT status FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceA, serviceLead.id]);
    assert.equal(serviceState.rows[0].status, 'Service Updated');
    const serviceAssignment = await fetch(`${createEndpoint}/${leadA}/assign`, { method:'POST', headers:serviceHeaders, body:JSON.stringify({ userId }) });
    assert.equal(serviceAssignment.status, 403);

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

    const archived = await fetch(`${createEndpoint}/${createdLead.id}`, { method:'DELETE', headers });
    assert.equal(archived.status, 200);
    const archivedDetail = await fetch(`${createEndpoint}/${createdLead.id}`, { headers });
    assert.equal(archivedDetail.status, 404);
    const restored = await fetch(`${createEndpoint}/${createdLead.id}/restore`, { method:'POST', headers, body:'{}' });
    assert.equal(restored.status, 200);
    const restoredDetail = await fetch(`${createEndpoint}/${createdLead.id}`, { headers });
    assert.equal(restoredDetail.status, 200);
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

    const assignedLeadsResponse = await fetch(`${base}/leads?q=Owned&status=New%20Lead`, { headers });
    assert.equal(assignedLeadsResponse.status, 200);
    const assignedLeads = await assignedLeadsResponse.json();
    assert.deepEqual(assignedLeads.data.map(item => item.id), [ownedLead]);
    const peerLeadsResponse = await fetch(`${base}/leads?q=Other&status=New%20Lead`, { headers });
    assert.equal(peerLeadsResponse.status, 200);
    const peerLeads = await peerLeadsResponse.json();
    assert.deepEqual(peerLeads.data, []);
    const inaccessibleLead = await fetch(`${base}/leads/${otherLead}`, { headers });
    assert.equal(inaccessibleLead.status, 404);
    const agentReassignment = await fetch(`${base}/leads/${ownedLead}/assign`, { method:'POST', headers, body:JSON.stringify({ userId:peerId }) });
    assert.equal(agentReassignment.status, 403);
    const activeAssignment = await db.query('SELECT user_id FROM lead_assignments WHERE workspace_id=$1 AND lead_id=$2 AND unassigned_at IS NULL', [workspaceId, ownedLead]);
    assert.deepEqual(activeAssignment.rows, [{ user_id:agentId }]);

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

test('CSV import previews mappings, reports physical row errors and exports the filtered scoped data', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { createRedBlackServer }, { createSession }, { parseCsv }] = await Promise.all([
    import('pg'), import('../backend/src/server.js'), import('../backend/src/auth.js'), import('../backend/src/csv.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceId = (await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', ['CSV Import', `csv-import-${suffix}`])).rows[0].id;
  const otherWorkspaceId = (await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', ['CSV Foreign', `csv-foreign-${suffix}`])).rows[0].id;
  const ownerId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`csv-owner-${suffix}@example.com`, 'CSV Owner'])).rows[0].id;
  const agentId = (await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`csv-agent-${suffix}@example.com`, 'CSV Agent'])).rows[0].id;
  await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent')", [workspaceId, ownerId, agentId]);
  const customFieldId = (await db.query("INSERT INTO custom_field_definitions(workspace_id,field_key,label,field_type,required) VALUES($1,'client_segment','Client Segment','text',true) RETURNING id", [workspaceId])).rows[0].id;
  const duplicateEmail = `existing-${suffix}@example.com`;
  await db.query("INSERT INTO leads(workspace_id,first_name,email,email_normalized,status) VALUES($1,'Existing',$2,$2,'Qualified')", [workspaceId, duplicateEmail]);
  await db.query("INSERT INTO leads(workspace_id,first_name,company_name,status) VALUES($1,'=1+1','Acme Formula','Qualified'),($1,'Other','Other Company','New Lead'),($2,'Foreign','Acme Foreign','Qualified'),($1,'Trashed','Acme Trashed','Qualified')", [workspaceId, otherWorkspaceId]);
  await db.query("UPDATE leads SET deleted_at=now() WHERE workspace_id=$1 AND first_name='Trashed'", [workspaceId]);
  const ownerSession = await createSession(db, { userId: ownerId, workspaceId });
  const server = createRedBlackServer({ db });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}/api/v1/workspaces/${workspaceId}`;
  const headers = {
    'content-type': 'application/json',
    cookie: `rb_session=${encodeURIComponent(ownerSession.token)}; rb_csrf=${encodeURIComponent(ownerSession.csrf)}`,
    'x-csrf-token': ownerSession.csrf
  };
  try {
    const csv = [
      'Given Name,Email Address,Company Name,Deal Size,Client Segment,Status',
      'Mira,mira@example.com,Acme New,2,Gold,Qualified',
      `Duplicate,${duplicateEmail},Acme Duplicate,3,Silver,Qualified`,
      '',
      ',,Acme Missing Contact,4,Silver,Qualified',
      'Bad Budget,bad-budget@example.com,Acme Bad Budget,not-a-number,Silver,Qualified'
    ].join('\r\n');
    const previewResponse = await fetch(`${base}/leads/import/preview`, { method: 'POST', headers, body: JSON.stringify({ csv }) });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.rowCount, 4);
    assert.equal(preview.suggestedMapping.firstName, 'Given Name');
    assert.equal(preview.suggestedMapping.email, 'Email Address');
    assert.equal(preview.suggestedMapping[`custom:${customFieldId}`], 'Client Segment');
    const importResponse = await fetch(`${base}/leads/import`, { method: 'POST', headers, body: JSON.stringify({ csv, mapping: preview.suggestedMapping }) });
    assert.equal(importResponse.status, 200);
    const summary = await importResponse.json();
    assert.equal(summary.totalRows, 4);
    assert.equal(summary.processed, 4);
    assert.equal(summary.created, 1);
    assert.equal(summary.skipped, 1);
    assert.deepEqual(summary.errors.map(error => error.row), [5, 6]);
    const imported = await db.query("SELECT id FROM leads WHERE workspace_id=$1 AND email_normalized='mira@example.com'", [workspaceId]);
    const importedField = await db.query('SELECT value FROM lead_custom_fields WHERE workspace_id=$1 AND lead_id=$2 AND field_definition_id=$3', [workspaceId, imported.rows[0].id, customFieldId]);
    assert.equal(importedField.rows[0].value, 'Gold');
    const importAudit = await db.query("SELECT metadata FROM audit_logs WHERE workspace_id=$1 AND action='leads.imported' ORDER BY created_at DESC LIMIT 1", [workspaceId]);
    assert.equal(importAudit.rows[0].metadata.errorCount, 2);

    const exportResponse = await fetch(`${base}/leads/export?q=Acme&status=Qualified`, { headers });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type'), /text\/csv/);
    assert.match(exportResponse.headers.get('content-disposition'), /redblack-leads\.csv/);
    const exported = parseCsv(await exportResponse.text());
    assert.equal(exported.records.length, 2);
    assert.equal(exported.headers.includes('Custom: Client Segment'), true);
    assert.equal(exported.records.some(record => record.values['First Name'] === "'=1+1"), true);
    assert.equal(exported.records.some(record => record.values.Company === 'Acme Foreign' || record.values.Company === 'Acme Trashed'), false);
    assert.equal(exported.records.some(record => record.values['Custom: Client Segment'] === 'Gold'), true);

    const agentSession = await createSession(db, { userId: agentId, workspaceId });
    await db.query("INSERT INTO leads(workspace_id,first_name,company_name,status) VALUES($1,'Assigned','AgentScope Owned','Qualified'),($1,'Unassigned','AgentScope Other','Qualified')", [workspaceId]);
    const agentLeads = await db.query("SELECT id FROM leads WHERE workspace_id=$1 AND company_name='AgentScope Owned'", [workspaceId]);
    await db.query("INSERT INTO lead_assignments(workspace_id,lead_id,user_id,assigned_by,reason) VALUES($1,$2,$3,$3,'test')", [workspaceId, agentLeads.rows[0].id, agentId]);
    const agentHeaders = {
      'content-type': 'application/json',
      cookie: `rb_session=${encodeURIComponent(agentSession.token)}; rb_csrf=${encodeURIComponent(agentSession.csrf)}`,
      'x-csrf-token': agentSession.csrf
    };
    const agentExportResponse = await fetch(`${base}/leads/export?q=AgentScope`, { headers: agentHeaders });
    assert.equal(agentExportResponse.status, 200);
    const agentExport = parseCsv(await agentExportResponse.text());
    assert.equal(agentExport.records.length, 1);
    assert.equal(agentExport.records[0].values.Company, 'AgentScope Owned');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});


test('PostgreSQL automation graph branches, journals decisions and resumes waits idempotently', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, { normalizeAutomation, dispatchAutomationEvent }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/server.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const token = randomUUID();
  try {
    await applyMigrations(db);
    const workspace = await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', [`Graph Test ${token.slice(0,8)}`, `graph-${token}`]);
    const workspaceId = workspace.rows[0].id;
    const user = await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`graph-${token}@example.test`, 'Graph Test']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, user.rows[0].id]);
    const lead = await db.query("INSERT INTO leads(workspace_id,first_name,status,score) VALUES($1,'Branch','Qualified',85) RETURNING id", [workspaceId]);
    const definition = normalizeAutomation({
      name: 'Qualified graph route', triggerType: 'message.incoming', triggerConfig: {},
      actions: [
        { type: 'update_lead', config: { status: 'Connected' } },
        { type: 'create_note', config: { title: 'YES branch executed', body: 'score, status and event matched' } },
        { type: 'create_note', config: { title: 'NO branch executed', body: 'condition did not match' } }
      ],
      graph: {
        version: 1, startNodeId: 'connect',
        nodes: [
          { id: 'connect', type: 'action', label: 'Mark connected', action: { type: 'update_lead', config: { status: 'Connected' } } },
          { id: 'qualified', type: 'condition', label: 'Qualified route', condition: { all: [
            { field: 'lead.score', operator: '>=', value: 70 },
            { field: 'lead.status', operator: '=', value: 'Connected' },
            { field: 'event.fromStageId', operator: '=', value: 'prior_stage' },
            { any: [
              { field: 'lead.status', operator: '=', value: 'Qualified' },
              { field: 'lead.status', operator: '=', value: 'Connected' }
            ] }
          ] } },
          { id: 'yes_note', type: 'action', label: 'YES note', action: { type: 'create_note', config: { title: 'YES branch executed', body: 'score, status and event matched' } } },
          { id: 'no_note', type: 'action', label: 'NO note', action: { type: 'create_note', config: { title: 'NO branch executed', body: 'condition did not match' } } },
          { id: 'end', type: 'end' }
        ],
        edges: [
          { from: 'connect', to: 'qualified', label: 'next' },
          { from: 'qualified', to: 'yes_note', label: 'yes' },
          { from: 'qualified', to: 'no_note', label: 'no' },
          { from: 'yes_note', to: 'end', label: 'next' },
          { from: 'no_note', to: 'end', label: 'next' }
        ]
      }
    });
    const automation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,$2,false,'message.incoming','{}'::jsonb,$3) RETURNING id", [workspaceId, definition.name, user.rows[0].id]);
    const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), user.rows[0].id]);
    await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'message.incoming', leadId: lead.rows[0].id, eventId: `graph:${token}`, actorUserId: user.rows[0].id, eventData: { fromStageId: 'prior_stage', channel: 'whatsapp' } });
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'message.incoming', leadId: lead.rows[0].id, eventId: `graph:${token}`, actorUserId: user.rows[0].id, eventData: { fromStageId: 'prior_stage', channel: 'whatsapp' } });
    const run = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND automation_id=$2 AND idempotency_key=$3', [workspaceId, automation.rows[0].id, `event:graph:${token}`]);
    assert.equal(run.rowCount, 1);
    await db.query("UPDATE automation_runs SET status='running' WHERE workspace_id=$1 AND id=$2", [workspaceId, run.rows[0].id]);
    await worker.runOne({ ...run.rows[0], attempt_count: 1, definition });
    await worker.runOne({ ...run.rows[0], attempt_count: 1, definition });
    const notes = await db.query("SELECT title FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title IN ('YES branch executed','NO branch executed')", [workspaceId, lead.rows[0].id]);
    assert.deepEqual(notes.rows.map(row => row.title), ['YES branch executed']);
    const steps = await db.query('SELECT position,status,result FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 ORDER BY position', [workspaceId, run.rows[0].id]);
    assert.equal(steps.rows.length, 3);
    assert.equal(steps.rows[1].result.branch, 'yes');
    assert.deepEqual(steps.rows[1].result.input.condition, definition.graph.nodes[1].condition);
    assert.deepEqual(steps.rows[1].result.output, { matched: true, branch: 'yes' });
    assert.equal(steps.rows[2].result.nodeId, 'yes_note');
    assert.equal(steps.rows[2].result.input.type, 'create_note');
    assert.ok(steps.rows[2].result.output.activityId);
    assert.ok(steps.rows.every(row => row.status === 'completed'));
    const state = await db.query('SELECT status FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, run.rows[0].id]);
    assert.equal(state.rows[0].status, 'completed');

    const waitDefinition = normalizeAutomation({
      name: 'Resumable graph wait', triggerType: 'manual', triggerConfig: {},
      actions: [{ type: 'create_note', config: { title: 'After wait', body: 'resumed once' } }],
      graph: { version: 1, startNodeId: 'wait', nodes: [
        { id: 'wait', type: 'wait', minutes: 2 },
        { id: 'after', type: 'action', action: { type: 'create_note', config: { title: 'After wait', body: 'resumed once' } } },
        { id: 'end', type: 'end' }
      ], edges: [{ from: 'wait', to: 'after', label: 'next' }, { from: 'after', to: 'end', label: 'next' }] }
    });
    const waitAutomation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,$2,false,'manual','{}'::jsonb,$3) RETURNING id", [workspaceId, waitDefinition.name, user.rows[0].id]);
    const waitVersion = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, waitAutomation.rows[0].id, JSON.stringify(waitDefinition), user.rows[0].id]);
    await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, waitAutomation.rows[0].id, waitVersion.rows[0].id]);
    const waitRun = await db.query("INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata) VALUES($1,$2,$3,$4,'running',$5,$6::jsonb) RETURNING *", [workspaceId, waitAutomation.rows[0].id, waitVersion.rows[0].id, lead.rows[0].id, `wait:${token}`, JSON.stringify({ requestedBy: user.rows[0].id })]);
    await worker.runOne({ ...waitRun.rows[0], attempt_count: 1, definition: waitDefinition });
    const suspended = await db.query('SELECT status,resume_at FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, waitRun.rows[0].id]);
    assert.equal(suspended.rows[0].status, 'queued');
    assert.ok(new Date(suspended.rows[0].resume_at) > new Date());
    const waitSteps = await db.query('SELECT position,status FROM automation_action_runs WHERE automation_run_id=$1 ORDER BY position', [waitRun.rows[0].id]);
    assert.deepEqual(waitSteps.rows.map(row => [row.position,row.status]), [[0,'completed']]);
    await db.query("UPDATE automation_runs SET status='running',resume_at=NULL WHERE workspace_id=$1 AND id=$2", [workspaceId, waitRun.rows[0].id]);
    await worker.runOne({ ...waitRun.rows[0], attempt_count: 2, definition: waitDefinition });
    const afterWait = await db.query("SELECT id FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title='After wait'", [workspaceId, lead.rows[0].id]);
    assert.equal(afterWait.rowCount, 1);
    const finished = await db.query('SELECT status FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, waitRun.rows[0].id]);
    assert.equal(finished.rows[0].status, 'completed');
  } finally {
    await db.end();
  }
});


test('PostgreSQL automation retries are bounded by failures, not wait resumes', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const token = randomUUID();
  try {
    await applyMigrations(db);
    const workspace = await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', [`Retry Test ${token.slice(0,8)}`, `retry-${token}`]);
    const workspaceId = workspace.rows[0].id;
    const user = await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`retry-${token}@example.test`, 'Retry Test']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, user.rows[0].id]);
    const automation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,'Retry test',false,'manual','{}'::jsonb,$2) RETURNING id", [workspaceId, user.rows[0].id]);
    const definition = { actions: [{ type: 'create_task', config: {} }] };
    const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), user.rows[0].id]);
    await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
    const run = await db.query("INSERT INTO automation_runs(workspace_id,automation_id,version_id,status,idempotency_key,metadata,attempt_count) VALUES($1,$2,$3,'running',$4,$5::jsonb,12) RETURNING *", [workspaceId, automation.rows[0].id, version.rows[0].id, `retry:${token}`, JSON.stringify({ requestedBy: user.rows[0].id, failureCount: 0 })]);
    for (let failure = 1; failure <= 3; failure += 1) {
      const current = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, run.rows[0].id]);
      await worker.runOne({ ...current.rows[0], attempt_count: 12, definition });
      const state = await db.query('SELECT status,metadata,attempt_count FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, run.rows[0].id]);
      assert.equal(state.rows[0].metadata.failureCount, failure);
      assert.equal(Number(state.rows[0].attempt_count), 12);
      assert.equal(state.rows[0].status, failure < 3 ? 'queued' : 'failed');
      if (failure < 3) await db.query("UPDATE automation_runs SET status='running',retry_after=NULL WHERE workspace_id=$1 AND id=$2", [workspaceId, run.rows[0].id]);
    }
  } finally {
    await db.end();
  }
});


test('PostgreSQL stage-change dispatch enforces nested trigger conditions using workspace lead context', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, { normalizeAutomation }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/server.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const token = randomUUID();
  try {
    await applyMigrations(db);
    const workspace = await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', [`Stage Trigger ${token.slice(0,8)}`, `stage-trigger-${token}`]);
    const workspaceId = workspace.rows[0].id;
    const user = await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`stage-trigger-${token}@example.test`, 'Stage Trigger Test']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, user.rows[0].id]);
    const lead = await db.query("INSERT INTO leads(workspace_id,first_name,status,score) VALUES($1,'Stage Trigger','Open',86) RETURNING id", [workspaceId]);
    const pipeline = await db.query("INSERT INTO pipelines(workspace_id,name,slug) VALUES($1,'Trigger Pipeline',$2) RETURNING id", [workspaceId, `trigger-${token}`]);
    const firstStage = await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'New','new',1) RETURNING id", [pipeline.rows[0].id]);
    const targetStage = await db.query("INSERT INTO pipeline_stages(pipeline_id,name,slug,position) VALUES($1,'Qualified','qualified',2) RETURNING id", [pipeline.rows[0].id]);
    await db.query('INSERT INTO lead_pipeline_entries(workspace_id,lead_id,pipeline_id,current_stage_id,is_current) VALUES($1,$2,$3,$4,true)', [workspaceId, lead.rows[0].id, pipeline.rows[0].id, firstStage.rows[0].id]);

    async function install(definition) {
      const automation = await db.query(
        "INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,$2,false,$3,$4::jsonb,$5) RETURNING id",
        [workspaceId, definition.name, definition.triggerType, JSON.stringify(definition.triggerConfig), user.rows[0].id]
      );
      const version = await db.query(
        'INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id',
        [workspaceId, automation.rows[0].id, JSON.stringify(definition), user.rows[0].id]
      );
      await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
      return { id: automation.rows[0].id, versionId: version.rows[0].id };
    }

    const parentDefinition = normalizeAutomation({
      name: 'Move to qualified', triggerType: 'manual', triggerConfig: {},
      actions: [{ type: 'change_stage', config: { pipelineId: pipeline.rows[0].id, stageId: targetStage.rows[0].id } }]
    });
    const parent = await install(parentDefinition);
    const matchingDefinition = normalizeAutomation({
      name: 'Nested matching stage trigger', triggerType: 'lead.stage_changed',
      triggerConfig: { all: [
        { field: 'lead.score', operator: '>=', value: 80 },
        { any: [
          { field: 'event.stageId', operator: '=', value: targetStage.rows[0].id },
          { field: 'event.stageId', operator: '=', value: firstStage.rows[0].id }
        ] }
      ] },
      actions: [{ type: 'create_note', config: { title: 'Nested trigger matched', body: 'Stage and lead conditions passed.' } }]
    });
    const nonMatchingDefinition = normalizeAutomation({
      name: 'Nested nonmatching stage trigger', triggerType: 'lead.stage_changed',
      triggerConfig: { all: [{ field: 'lead.score', operator: '>=', value: 95 }] },
      actions: [{ type: 'create_note', config: { title: 'Nested trigger should not run', body: 'Score condition failed.' } }]
    });
    const matching = await install(matchingDefinition);
    const nonMatching = await install(nonMatchingDefinition);
    const parentRun = await db.query(
      "INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata) VALUES($1,$2,$3,$4,'running',$5,$6::jsonb) RETURNING *",
      [workspaceId, parent.id, parent.versionId, lead.rows[0].id, `stage-parent:${token}`, JSON.stringify({ requestedBy: user.rows[0].id })]
    );
    await worker.runOne({ ...parentRun.rows[0], definition: parentDefinition });

    const queued = await db.query(
      'SELECT automation_id,metadata FROM automation_runs WHERE workspace_id=$1 AND automation_id=ANY($2::uuid[])',
      [workspaceId, [matching.id, nonMatching.id]]
    );
    assert.deepEqual(queued.rows.map(row => row.automation_id), [matching.id]);
    assert.deepEqual(queued.rows[0].metadata.eventData, {
      pipelineId: pipeline.rows[0].id,
      fromStageId: firstStage.rows[0].id,
      stageId: targetStage.rows[0].id,
      toStageId: targetStage.rows[0].id,
      status: 'Qualified'
    });
    const changed = await db.query('SELECT current_stage_id FROM lead_pipeline_entries WHERE workspace_id=$1 AND lead_id=$2 AND is_current=true', [workspaceId, lead.rows[0].id]);
    assert.equal(changed.rows[0].current_stage_id, targetStage.rows[0].id);
  } finally {
    await db.end();
  }
});


test('PostgreSQL automation retry preserves completed steps and exposes step errors safely', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, { normalizeAutomation, createRedBlackServer }, { createSession }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/server.js'), import('../backend/src/auth.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const token = randomUUID();
  let server;
  try {
    await applyMigrations(db);
    const workspace = await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', [`Retry Test ${token.slice(0,8)}`, `retry-test-${token}`]);
    const workspaceId = workspace.rows[0].id;
    const user = await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`retry-test-${token}@example.test`, 'Retry Test Owner']);
    const userId = user.rows[0].id;
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
    const lead = await db.query("INSERT INTO leads(workspace_id,first_name) VALUES($1,'Retry Lead') RETURNING id", [workspaceId]);
    const definition = normalizeAutomation({
      name: 'Safe retry workflow', triggerType: 'manual', triggerConfig: {},
      actions: [{ type: 'create_note', config: { title: 'Once only', body: 'Completed before the next action failed.' } }]
    });
    const automation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,$2,false,'manual','{}'::jsonb,$3) RETURNING id", [workspaceId, definition.name, userId]);
    const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), userId]);
    await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
    const runResult = await db.query(
      "INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata) VALUES($1,$2,$3,$4,'running',$5,$6::jsonb) RETURNING *",
      [workspaceId, automation.rows[0].id, version.rows[0].id, lead.rows[0].id, `retry-run:${token}`, JSON.stringify({ requestedBy: userId })]
    );
    const runId = runResult.rows[0].id;
    const failingDefinition = {
      actions: [
        { type: 'create_note', config: { title: 'Once only', body: 'Completed before the next action failed.' } },
        { type: 'unsupported_test_action', config: { reason: 'exercise failure journal' } }
      ]
    };
    await worker.runOne({ ...runResult.rows[0], definition: failingDefinition });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, runId]);
      await worker.runOne({ ...current.rows[0], definition: failingDefinition });
    }

    const failed = await db.query('SELECT status,metadata FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, runId]);
    assert.equal(failed.rows[0].status, 'failed');
    const initialSteps = await db.query('SELECT position,status,result FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 ORDER BY position', [workspaceId, runId]);
    assert.equal(initialSteps.rows[0].status, 'completed');
    assert.equal(initialSteps.rows[0].result.input.type, 'create_note');
    assert.ok(initialSteps.rows[0].result.output.activityId);
    assert.equal(initialSteps.rows[1].status, 'failed');
    assert.equal(initialSteps.rows[1].result.input.type, 'unsupported_test_action');
    assert.match(initialSteps.rows[1].result.error, /not supported/);

    const session = await createSession(db, { userId, workspaceId });
    server = createRedBlackServer({ db });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/workspaces/${workspaceId}/automations/${automation.rows[0].id}/runs/${runId}/retry`;
    const headers = {
      'content-type': 'application/json',
      cookie: `rb_session=${encodeURIComponent(session.token)}; rb_csrf=${encodeURIComponent(session.csrf)}`,
      'x-csrf-token': session.csrf
    };
    const retry = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
    assert.equal(retry.status, 202);
    const queued = await retry.json();
    assert.equal(queued.status, 'queued');

    await db.query("UPDATE automation_runs SET status='running' WHERE workspace_id=$1 AND id=$2", [workspaceId, runId]);
    const retryRun = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, runId]);
    await worker.runOne({ ...retryRun.rows[0], definition: failingDefinition });
    const noteCount = await db.query("SELECT COUNT(*)::int AS count FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title='Once only'", [workspaceId, lead.rows[0].id]);
    assert.equal(noteCount.rows[0].count, 1);
    const retriedSteps = await db.query('SELECT position,status,result FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 ORDER BY position', [workspaceId, runId]);
    assert.equal(retriedSteps.rows[0].status, 'completed');
    assert.equal(retriedSteps.rows[1].result.input.type, 'unsupported_test_action');
    assert.match(retriedSteps.rows[1].result.error, /not supported/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.end();
  }
});


test('PostgreSQL automation waits resume once on matching events and lead conditions', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ENV = 'test';
  const [{ Pool }, { applyMigrations }, { normalizeAutomation, dispatchAutomationEvent }, worker] = await Promise.all([
    import('pg'), import('../backend/src/migrate.js'), import('../backend/src/server.js'), import('../backend/src/worker.js')
  ]);
  const db = new Pool({ connectionString: databaseUrl });
  const token = randomUUID();
  try {
    await applyMigrations(db);
    const workspace = await db.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id', [`Wait Test ${token.slice(0,8)}`, `wait-test-${token}`]);
    const workspaceId = workspace.rows[0].id;
    const user = await db.query('INSERT INTO users(email,display_name) VALUES($1,$2) RETURNING id', [`wait-test-${token}@example.test`, 'Wait Test Owner']);
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, user.rows[0].id]);
    const lead = await db.query("INSERT INTO leads(workspace_id,first_name,status) VALUES($1,'Wait Lead','Open') RETURNING id", [workspaceId]);
    async function install(definition, key) {
      const automation = await db.query("INSERT INTO automations(workspace_id,name,active,trigger_type,trigger_config,created_by) VALUES($1,$2,false,'manual','{}'::jsonb,$3) RETURNING id", [workspaceId, definition.name, user.rows[0].id]);
      const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), user.rows[0].id]);
      await db.query('UPDATE automations SET current_version_id=$3,active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
      const run = await db.query("INSERT INTO automation_runs(workspace_id,automation_id,version_id,lead_id,status,idempotency_key,metadata) VALUES($1,$2,$3,$4,'running',$5,$6::jsonb) RETURNING *", [workspaceId, automation.rows[0].id, version.rows[0].id, lead.rows[0].id, key, JSON.stringify({ requestedBy: user.rows[0].id })]);
      return { run: run.rows[0], definition };
    }

    const eventDefinition = normalizeAutomation({
      name: 'Wait for message response', triggerType: 'manual', triggerConfig: {},
      actions: [{ type: 'create_note', config: { title: 'Response received', body: 'Resumed from an incoming message.' } }],
      graph: { version: 1, startNodeId: 'wait', nodes: [
        { id: 'wait', type: 'wait', mode: 'event', eventType: 'message.incoming', timeoutMinutes: 30 },
        { id: 'note', type: 'action', action: { type: 'create_note', config: { title: 'Response received', body: 'Resumed from an incoming message.' } } },
        { id: 'end', type: 'end' }
      ], edges: [{ from: 'wait', to: 'note', label: 'next' }, { from: 'note', to: 'end', label: 'next' }] }
    });
    const eventWait = await install(eventDefinition, `event-wait:${token}`);
    await worker.runOne({ ...eventWait.run, definition: eventDefinition });
    const suspendedEvent = await db.query('SELECT status,metadata FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, eventWait.run.id]);
    assert.equal(suspendedEvent.rows[0].status, 'queued');
    assert.equal(suspendedEvent.rows[0].metadata.waitFor.eventType, 'message.incoming');
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.updated', leadId: lead.rows[0].id, eventId: `unmatched:${token}`, eventData: { fields: ['status'] } });
    const stillWaiting = await db.query('SELECT metadata FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, eventWait.run.id]);
    assert.equal(stillWaiting.rows[0].metadata.waitFor.eventType, 'message.incoming');
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'message.incoming', leadId: lead.rows[0].id, eventId: `response:${token}`, eventData: { messageId: token, channel: 'email' } });
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'message.incoming', leadId: lead.rows[0].id, eventId: `response:${token}`, eventData: { messageId: token, channel: 'email' } });
    await db.query("UPDATE automation_runs SET status='running' WHERE workspace_id=$1 AND id=$2", [workspaceId, eventWait.run.id]);
    const resumedEventRun = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, eventWait.run.id]);
    await worker.runOne({ ...resumedEventRun.rows[0], definition: eventDefinition });
    const responseNote = await db.query("SELECT id FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title='Response received'", [workspaceId, lead.rows[0].id]);
    assert.equal(responseNote.rowCount, 1);
    const eventWaitStep = await db.query('SELECT result FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 AND position=0', [workspaceId, eventWait.run.id]);
    assert.deepEqual(eventWaitStep.rows[0].result.waitOutcome, { waitedFor: 'event', eventType: 'message.incoming', timedOut: false });

    const conditionDefinition = normalizeAutomation({
      name: 'Wait for connected status', triggerType: 'manual', triggerConfig: {},
      actions: [{ type: 'create_note', config: { title: 'Lead connected', body: 'Resumed after lead update.' } }],
      graph: { version: 1, startNodeId: 'wait_condition', nodes: [
        { id: 'wait_condition', type: 'wait', mode: 'condition', condition: { all: [{ field: 'lead.status', operator: '=', value: 'Connected' }] } },
        { id: 'condition_note', type: 'action', action: { type: 'create_note', config: { title: 'Lead connected', body: 'Resumed after lead update.' } } },
        { id: 'condition_end', type: 'end' }
      ], edges: [{ from: 'wait_condition', to: 'condition_note', label: 'next' }, { from: 'condition_note', to: 'condition_end', label: 'next' }] }
    });
    const conditionWait = await install(conditionDefinition, `condition-wait:${token}`);
    await worker.runOne({ ...conditionWait.run, definition: conditionDefinition });
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.updated', leadId: lead.rows[0].id, eventId: `still-open:${token}`, eventData: { fields: ['notes'] } });
    const conditionStillWaiting = await db.query('SELECT metadata FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, conditionWait.run.id]);
    assert.equal(conditionStillWaiting.rows[0].metadata.waitFor.mode, 'condition');
    await db.query("UPDATE leads SET status='Connected' WHERE workspace_id=$1 AND id=$2", [workspaceId, lead.rows[0].id]);
    await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.updated', leadId: lead.rows[0].id, eventId: `connected:${token}`, eventData: { fields: ['status'] } });
    await db.query("UPDATE automation_runs SET status='running' WHERE workspace_id=$1 AND id=$2", [workspaceId, conditionWait.run.id]);
    const resumedConditionRun = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND id=$2', [workspaceId, conditionWait.run.id]);
    await worker.runOne({ ...resumedConditionRun.rows[0], definition: conditionDefinition });
    const connectedNote = await db.query("SELECT id FROM activities WHERE workspace_id=$1 AND lead_id=$2 AND type='note' AND title='Lead connected'", [workspaceId, lead.rows[0].id]);
    assert.equal(connectedNote.rowCount, 1);
  } finally {
    await db.end();
  }
});

