import type postgres from "postgres";
import { getSchemaName } from "./connection.js";

const CURRENT_VERSION = 1;

export async function migrate(sql: postgres.Sql): Promise<void> {
  const schemaName = getSchemaName();

  // Create schema if not exists
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

  // Create schema_version table if not exists
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".schema_version (
      version numeric NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Check current version
  const rows = await sql.unsafe(
    `SELECT version FROM "${schemaName}".schema_version ORDER BY applied_at DESC LIMIT 1`,
  );
  const currentVersion = rows.length > 0 ? Number(rows[0].version) : 0;

  if (currentVersion >= CURRENT_VERSION) {
    return;
  }

  // Apply migrations in a transaction
  await sql.begin(async (tx) => {
    if (currentVersion < 1) {
      await applyV1(tx, schemaName);
    }

    await tx.unsafe(
      `INSERT INTO "${schemaName}".schema_version (version) VALUES (${CURRENT_VERSION})`,
    );
  });
}

async function applyV1(
  tx: postgres.TransactionSql,
  schemaName: string,
): Promise<void> {
  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".settings (
      key text PRIMARY KEY,
      value text NOT NULL
    )
  `);

  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".categories (
      id uuid PRIMARY KEY,
      name text NOT NULL UNIQUE,
      parent_id uuid REFERENCES "${schemaName}".categories(id),
      type text NOT NULL CHECK (type IN ('expense', 'income')),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".tags (
      id uuid PRIMARY KEY,
      name text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".transactions (
      id uuid PRIMARY KEY,
      category_id uuid REFERENCES "${schemaName}".categories(id),
      amount numeric(19,4) NOT NULL,
      currency text NOT NULL DEFAULT 'USD',
      description text,
      date timestamptz NOT NULL,
      metadata jsonb DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".transaction_tags (
      transaction_id uuid NOT NULL REFERENCES "${schemaName}".transactions(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES "${schemaName}".tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    )
  `);

  await tx.unsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}".budgets (
      id uuid PRIMARY KEY,
      category_id uuid NOT NULL REFERENCES "${schemaName}".categories(id),
      amount numeric(19,4) NOT NULL,
      period text NOT NULL CHECK (period IN ('monthly', 'weekly')),
      start_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Insert default currency setting
  await tx.unsafe(`
    INSERT INTO "${schemaName}".settings (key, value) VALUES ('default_currency', 'USD')
    ON CONFLICT (key) DO NOTHING
  `);
}
