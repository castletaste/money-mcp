import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schemaExports from "../db/schema.js";
import { migrate } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { createMcpServer } from "../server.js";
import { registerTagTools } from "./tags.js";

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
  registerTagTools(server, db);

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

describe("list_tags", () => {
  test("returns empty list initially", async () => {
    const result = await callTool("list_tags");
    const data = parseText(result) as Array<{ id: string; name: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});

describe("create_tag", () => {
  test("creates a new tag", async () => {
    const result = await callTool("create_tag", { name: "groceries" });
    const data = parseText(result) as { id: string; name: string };
    expect(data.name).toBe("groceries");
    expect(data.id).toBeTruthy();
  });

  test("rejects duplicate tag name", async () => {
    await callTool("create_tag", { name: "duplicate-tag" });
    const result = await callTool("create_tag", { name: "duplicate-tag" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("already exists");
  });

  test("list_tags returns created tags", async () => {
    await callTool("create_tag", { name: "travel" });
    const result = await callTool("list_tags");
    const data = parseText(result) as Array<{ id: string; name: string }>;
    expect(data.some((t) => t.name === "travel")).toBe(true);
    expect(data.some((t) => t.name === "groceries")).toBe(true);
  });
});

describe("delete_tag", () => {
  test("deletes a tag with no associations", async () => {
    const created = await callTool("create_tag", { name: "to-delete" });
    const tag = parseText(created) as { id: string };

    const result = await callTool("delete_tag", { id: tag.id });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("Deleted tag");

    // Verify it's gone
    const list = await callTool("list_tags");
    const tags = parseText(list) as Array<{ name: string }>;
    expect(tags.some((t) => t.name === "to-delete")).toBe(false);
  });

  test("cascade deletes transaction_tags associations", async () => {
    const created = await callTool("create_tag", { name: "cascade-test" });
    const tag = parseText(created) as { id: string };

    // Create a transaction and link it to the tag via transaction_tags
    const { v7: uuidv7 } = await import("uuid");
    const txId = uuidv7();

    // First create a category for the transaction
    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}".categories (id, name, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [uuidv7(), "CascadeTestCat", "expense"],
    );
    const catRows = await sql.unsafe(
      `SELECT id FROM "${TEST_SCHEMA}".categories WHERE name = 'CascadeTestCat'`,
    );

    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}".transactions (id, category_id, amount, currency, date) VALUES ($1, $2, $3, $4, NOW())`,
      [txId, catRows[0].id, "-10.0000", "USD"],
    );
    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}".transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [txId, tag.id],
    );

    // Verify the association exists
    const before = await sql.unsafe(
      `SELECT COUNT(*) as cnt FROM "${TEST_SCHEMA}".transaction_tags WHERE tag_id = $1`,
      [tag.id],
    );
    expect(Number(before[0].cnt)).toBe(1);

    // Delete the tag - should cascade
    const result = await callTool("delete_tag", { id: tag.id });
    expect(result.isError).toBeFalsy();

    // Verify transaction_tags association is gone
    const after = await sql.unsafe(
      `SELECT COUNT(*) as cnt FROM "${TEST_SCHEMA}".transaction_tags WHERE tag_id = $1`,
      [tag.id],
    );
    expect(Number(after[0].cnt)).toBe(0);

    // Verify the transaction itself still exists
    const txExists = await sql.unsafe(
      `SELECT COUNT(*) as cnt FROM "${TEST_SCHEMA}".transactions WHERE id = $1`,
      [txId],
    );
    expect(Number(txExists[0].cnt)).toBe(1);
  });

  test("rejects deleting non-existent tag", async () => {
    const result = await callTool("delete_tag", {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Tag not found");
  });
});
