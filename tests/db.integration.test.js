import test from 'node:test';
import assert from 'node:assert/strict';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL migrations apply idempotently and install tenant/security controls', { skip: !databaseUrl }, async () => {
  const [{ Pool }, { applyMigrations }] = await Promise.all([import('pg'), import('../backend/src/migrate.js')]);
  const db = new Pool({ connectionString: databaseUrl });
  try {
    await applyMigrations(db);
    await applyMigrations(db);
    const migrations = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map(row => row.version), ['0001_redblack_crm_core.sql', '0002_security_idempotency_and_operations.sql', '0003_automation_parity.sql', '0004_automation_default_backfill.sql']);
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
    const run = await worker.claimRun();
    assert.equal(run.lead_id, lead.rows[0].id);
    await worker.runOne(run);
    const tasks = await db.query("SELECT id FROM tasks WHERE workspace_id=$1 AND lead_id=$2 AND source='automation'", [workspaceId, lead.rows[0].id]);
    assert.equal(tasks.rowCount, 1);
  } finally {
    await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    await db.end();
  }
});


