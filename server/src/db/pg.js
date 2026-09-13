import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
  console.error('[pg] idle client error:', err.message);
});

export async function q(text, params) {
  const t0 = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - t0;
  if (ms > 400) console.warn(`[pg] slow (${ms}ms): ${text.slice(0, 90)}`);
  return res;
}

export async function one(text, params) {
  const r = await q(text, params);
  return r.rows[0] || null;
}

export async function many(text, params) {
  const r = await q(text, params);
  return r.rows;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

let available = null;
export async function pgAvailable() {
  if (available !== null) return available;
  try {
    await pool.query('SELECT 1');
    available = true;
  } catch (e) {
    console.warn('[pg] unavailable:', e.message);
    available = false;
  }
  return available;
}
