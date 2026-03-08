import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import postgres from "postgres";
import { migrate } from "./migrate.js";
import { seed, DEFAULT_CATEGORIES } from "./seed.js";

const TEST_SCHEMA = `mcp_money_test_${Date.now()}`;
let sql: postgres.Sql;

beforeAll(() => {
  process.env.MCP_MONEY_SCHEMA = TEST_SCHEMA;
  sql = postgres(process.env.DATABASE_URL!);
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await sql.end();
});

describe("migrate", () => {
  test("creates schema and all tables", async () => {
    await migrate(sql);

    const tables = await sql.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [TEST_SCHEMA],
    );

    const tableNames = tables.map((r: any) => r.table_name).sort();
    expect(tableNames).toEqual([
      "budgets",
      "categories",
      "schema_version",
      "settings",
      "tags",
      "transaction_tags",
      "transactions",
    ]);
  });

  test("records version in schema_version", async () => {
    const rows = await sql.unsafe(
      `SELECT version FROM "${TEST_SCHEMA}".schema_version`,
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].version)).toBe(1);
  });

  test("is idempotent - running again does not error or duplicate version", async () => {
    await migrate(sql);

    const rows = await sql.unsafe(
      `SELECT version FROM "${TEST_SCHEMA}".schema_version ORDER BY applied_at`,
    );
    // Should still have just one version row (didn't re-apply)
    expect(rows.length).toBe(1);
  });

  test("creates settings with default currency", async () => {
    const rows = await sql.unsafe(
      `SELECT value FROM "${TEST_SCHEMA}".settings WHERE key = 'default_currency'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe("USD");
  });
});

describe("seed", () => {
  test("inserts default categories", async () => {
    await seed(sql);

    const rows = await sql.unsafe(
      `SELECT name, type FROM "${TEST_SCHEMA}".categories ORDER BY name`,
    );

    expect(rows.length).toBe(DEFAULT_CATEGORIES.length);

    for (const cat of DEFAULT_CATEGORIES) {
      const found = rows.find((r: any) => r.name === cat.name);
      expect(found).toBeTruthy();
      expect(found.type).toBe(cat.type);
    }
  });

  test("is idempotent - running again does not duplicate categories", async () => {
    await seed(sql);

    const rows = await sql.unsafe(
      `SELECT name FROM "${TEST_SCHEMA}".categories`,
    );
    expect(rows.length).toBe(DEFAULT_CATEGORIES.length);
  });
});
