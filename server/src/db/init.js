import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema ready');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initSchema()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[db] init failed:', e.message);
      process.exit(1);
    });
}
