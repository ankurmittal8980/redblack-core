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
    assert.deepEqual(migrations.rows.map(row => row.version), ['0001_redblack_crm_core.sql', '0002_security_idempotency_and_operations.sql']);
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


