import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schemaExports from "../db/schema.js";
import { migrate } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { createMcpServer } from "../server.js";
import { registerUtilTools } from "./utils.js";

const TEST_SCHEMA = process.env.MCP_MONEY_SCHEMA!;
let sql: postgres.Sql;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

beforeAll(async () => {
  sql = postgres(process.env.DATABASE_URL!);
  await migrate(sql);
  await seed(sql);

  const db = drizzle(sql, { schema: schemaExports });
  server = createMcpServer();
  registerUtilTools(server, db);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await sql.end();
});

function callTool(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function parseText(result: Awaited<ReturnType<typeof callTool>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

function getText(result: Awaited<ReturnType<typeof callTool>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

describe("set_currency", () => {
  test("changes the default currency", async () => {
    const result = await callTool("set_currency", { currency: "EUR" });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("EUR");

    // Verify it persisted in the database
    const rows = await sql.unsafe(
      `SELECT value FROM "${TEST_SCHEMA}".settings WHERE key = 'default_currency'`,
    );
    expect(rows[0].value).toBe("EUR");
  });

  test("uppercases the currency code", async () => {
    const result = await callTool("set_currency", { currency: "rub" });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("RUB");

    const rows = await sql.unsafe(
      `SELECT value FROM "${TEST_SCHEMA}".settings WHERE key = 'default_currency'`,
    );
    expect(rows[0].value).toBe("RUB");
  });

  test("setting currency persists across reads", async () => {
    await callTool("set_currency", { currency: "GBP" });

    // Read back via health_check
    const health = await callTool("health_check");
    const data = parseText(health) as { default_currency: string };
    expect(data.default_currency).toBe("GBP");
  });
});

describe("health_check", () => {
  test("returns expected fields", async () => {
    const result = await callTool("health_check");
    expect(result.isError).toBeFalsy();

    const data = parseText(result) as Record<string, unknown>;
    expect(data.status).toBe("ok");
    expect(data.schema_version).toBe(2);
    expect(typeof data.transaction_count).toBe("number");
    expect(typeof data.category_count).toBe("number");
    expect(data.default_currency).toBeTruthy();
  });

  test("reports correct category count from seed", async () => {
    const result = await callTool("health_check");
    const data = parseText(result) as { category_count: number };
    // Seed creates 10 default categories; other test files may add more
    expect(data.category_count).toBeGreaterThanOrEqual(10);
  });

  test("reports transaction count as number", async () => {
    const result = await callTool("health_check");
    const data = parseText(result) as { transaction_count: number };
    // Other test files may have inserted transactions in the shared schema
    expect(data.transaction_count).toBeGreaterThanOrEqual(0);
  });
});
