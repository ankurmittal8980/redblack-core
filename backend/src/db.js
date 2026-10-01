import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'redblack-core'
});

export async function transaction(dbOrCallback, callbackArgument) {
  const db = typeof dbOrCallback === 'function' ? pool : dbOrCallback;
  const callback = typeof dbOrCallback === 'function' ? dbOrCallback : callbackArgument;
  if (!db || typeof db.connect !== 'function' || typeof callback !== 'function') {
    throw new TypeError('transaction requires a database pool and callback.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}

