import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closeDatabase } from './db.js';

const migrationDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function applyMigrations(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(migrationDirectory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(path.join(migrationDirectory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prior = await db.query('SELECT checksum FROM schema_migrations WHERE version = $1', [name]);
    if (prior.rows[0]) {
      if (prior.rows[0].checksum.trim() !== checksum) throw new Error(`Applied migration ${name} has changed; add a new migration instead.`);
      continue;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['redblack-core-schema-migrations']);
      const recheck = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [name]);
      if (recheck.rows[0]) {
        if (recheck.rows[0].checksum.trim() !== checksum) throw new Error(`Applied migration ${name} has changed.`);
      } else {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES($1, $2)', [name, checksum]);
      }
      await client.query('COMMIT');
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

// migrate.js is the dedicated migration executable used by Docker and package scripts.
// Execute whenever this module is launched as the process entrypoint. Tests import
// applyMigrations() through a query-string module URL, so imports remain side-effect free.
const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === new URL(`file://${path.resolve(process.argv[1]).replaceAll('\\\\', '/')}`).href;

if (invokedAsScript) {
  try {
    await applyMigrations();
    await closeDatabase();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    await closeDatabase();
    process.exitCode = 1;
  }
}

