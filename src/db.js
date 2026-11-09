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
      tipo TEXT NOT NULL DEFAULT 'propio',
      proveedor TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Por si la tabla ya existía de antes de que agregáramos Drop Shipping.
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'propio';`);
  await pool.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS proveedor TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ordenes_drop (
      id SERIAL PRIMARY KEY,
      ml_item_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      proveedor TEXT,
      cantidad INTEGER NOT NULL DEFAULT 1,
      comprador TEXT,
      direccion_envio TEXT,
      estado TEXT NOT NULL DEFAULT 'lista_para_facturar',
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      facturada_en TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      impuestos_pct NUMERIC DEFAULT 0,
      spl_usuario TEXT,
      spl_clave_hash TEXT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT single_row_config CHECK (id = 1)
    );
  `);

  // Por si la tabla config ya existía de antes de que agregáramos el login del Panel SPL.
  await pool.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS spl_usuario TEXT;`);
  await pool.query(`ALTER TABLE config ADD COLUMN IF NOT EXISTS spl_clave_hash TEXT;`);

  await pool.query(`
    INSERT INTO config (id, impuestos_pct)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `);
}

module.exports = { pool, migrate };
