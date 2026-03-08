import type postgres from "postgres";
import { getSchemaName } from "./connection.js";

const CURRENT_VERSION = 2;

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

  // Apply migrations in a transaction, locking schema_version to serialize
  // concurrent startup attempts and prevent duplicate migration runs.
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `LOCK TABLE "${schemaName}".schema_version IN EXCLUSIVE MODE`,
    );

    const rows = await tx.unsafe(
      `SELECT version FROM "${schemaName}".schema_version ORDER BY applied_at DESC LIMIT 1`,
    );
    const currentVersion = rows.length > 0 ? Number(rows[0].version) : 0;

    if (currentVersion >= CURRENT_VERSION) {
      return;
    }

    if (currentVersion < 1) {
      await applyV1(tx, schemaName);
    }
    if (currentVersion < 2) {
      await applyV2(tx, schemaName);
    }

    await tx.unsafe(
      `INSERT INTO "${schemaName}".schema_version (version) VALUES (${CURRENT_VERSION})`,
    );
  });
}

async function applyV2(
  tx: postgres.TransactionSql,
  schemaName: string,
): Promise<void> {
  // The product is monthly-only. Remove any non-monthly budgets first so that
  // the subsequent dedup (which keys on category_id + start_date without period)
  // cannot silently drop a valid row of a different period type.
  await tx.unsafe(`
    DELETE FROM "${schemaName}".budgets WHERE period != 'monthly'
  `);

  // Remove duplicate (category_id, start_date) rows before adding the unique constraint.
  // Keeps the most recently created budget per pair; safe to run even if no duplicates exist.
  await tx.unsafe(`
    DELETE FROM "${schemaName}".budgets
    WHERE id NOT IN (
      SELECT DISTINCT ON (category_id, start_date) id
      FROM "${schemaName}".budgets
      ORDER BY category_id, start_date, created_at DESC
    )
  `);

  await tx.unsafe(`
    ALTER TABLE "${schemaName}".budgets
    ADD CONSTRAINT budgets_category_id_start_date_key UNIQUE (category_id, start_date)
  `);

  // Narrow the period check constraint to enforce monthly-only at the DB level.
  // The original unnamed constraint is typically named budgets_period_check by PostgreSQL.
  await tx.unsafe(`
    ALTER TABLE "${schemaName}".budgets
    DROP CONSTRAINT IF EXISTS budgets_period_check
  `);
  await tx.unsafe(`
    ALTER TABLE "${schemaName}".budgets
    ADD CONSTRAINT budgets_period_check CHECK (period = 'monthly')
  `);
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
