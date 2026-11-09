const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ml_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ml_user_id TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS productos (
      ml_item_id TEXT PRIMARY KEY,
      costo NUMERIC,
      notas TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

module.exports = { pool, migrate };
