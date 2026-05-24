const { Pool } = require('pg');
const { join } = require('path');
require('dotenv').config({ path: join(__dirname, '.env') });
const databaseUrl = process.env.NODE_ENV === 'test' && process.env.DATABASE_TEST_URL
  ? process.env.DATABASE_TEST_URL
  : process.env.DATABASE_URL;
const sslConfig = /[?&]sslmode=|[?&]ssl=/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl: sslConfig });
(async () => {
  try {
    const client = await pool.connect();
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_events' ORDER BY ordinal_position");
    console.log('webhook_events columns:', cols.rows.map((r) => r.column_name).join(', '));
    const records = await client.query('SELECT version, filename FROM schema_migrations ORDER BY version');
    console.log('schema_migrations records:', records.rows.map((r) => `${r.version}:${r.filename}`).join(', '));
    client.release();
  } catch (err) {
    console.error('ERR', err.message);
  } finally {
    await pool.end();
  }
})();
