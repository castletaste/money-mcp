import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schemaExports from "../db/schema.js";
import { migrate } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { createMcpServer } from "../server.js";
import { registerCategoryTools } from "./categories.js";

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
  registerCategoryTools(server, db);

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

describe("list_categories", () => {
  test("returns seeded categories grouped by type", async () => {
    const result = await callTool("list_categories");
    const data = parseText(result) as Array<{
      type: string;
      categories: Array<{ id: string; name: string }>;
    }>;

    expect(data.length).toBeGreaterThanOrEqual(1);

    const expense = data.find((g) => g.type === "expense");
    expect(expense).toBeTruthy();
    expect(expense!.categories.length).toBeGreaterThanOrEqual(9);

    const income = data.find((g) => g.type === "income");
    expect(income).toBeTruthy();
    expect(income!.categories.some((c) => c.name === "Salary")).toBe(true);
  });
});

describe("create_category", () => {
  test("creates a new expense category", async () => {
    const result = await callTool("create_category", {
      name: "TestExpense",
      type: "expense",
    });

    const data = parseText(result) as {
      id: string;
      name: string;
      type: string;
      parentId: string | null;
    };
    expect(data.name).toBe("TestExpense");
    expect(data.type).toBe("expense");
    expect(data.parentId).toBeNull();
    expect(data.id).toBeTruthy();
  });

  test("creates a child category (one level nesting)", async () => {
    const parentResult = await callTool("create_category", {
      name: "ParentCat",
      type: "expense",
    });
    const parent = parseText(parentResult) as { id: string };

    const childResult = await callTool("create_category", {
      name: "ChildCat",
      type: "expense",
      parent_id: parent.id,
    });
    const child = parseText(childResult) as {
      id: string;
      parentId: string;
    };
    expect(child.parentId).toBe(parent.id);
  });

  test("rejects nesting deeper than one level", async () => {
    const p = await callTool("create_category", {
      name: "Level0",
      type: "expense",
    });
    const parent = parseText(p) as { id: string };

    const c = await callTool("create_category", {
      name: "Level1",
      type: "expense",
      parent_id: parent.id,
    });
    const child = parseText(c) as { id: string };

    const gc = await callTool("create_category", {
      name: "Level2",
      type: "expense",
      parent_id: child.id,
    });
    expect(gc.isError).toBe(true);
    expect(getText(gc)).toContain("Cannot nest more than one level");
  });

  test("rejects non-existent parent_id", async () => {
    const result = await callTool("create_category", {
      name: "OrphanCat",
      type: "expense",
      parent_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Parent category not found");
  });
});

describe("delete_category", () => {
  test("deletes a category with no references", async () => {
    const created = await callTool("create_category", {
      name: "ToDelete",
      type: "expense",
    });
    const cat = parseText(created) as { id: string };

    const result = await callTool("delete_category", { id: cat.id });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("Deleted category");
  });

  test("rejects deleting category with transactions (RESTRICT)", async () => {
    const created = await callTool("create_category", {
      name: "HasTxCat",
      type: "expense",
    });
    const cat = parseText(created) as { id: string };

    const { v7: uuidv7 } = await import("uuid");
    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}".transactions (id, category_id, amount, currency, date) VALUES ($1, $2, $3, $4, NOW())`,
      [uuidv7(), cat.id, "-50.0000", "USD"],
    );

    const result = await callTool("delete_category", { id: cat.id });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("transaction(s) still reference it");
  });

  test("rejects deleting category with child categories", async () => {
    const parent = await callTool("create_category", {
      name: "ParentToKeep",
      type: "expense",
    });
    const parentData = parseText(parent) as { id: string };

    await callTool("create_category", {
      name: "ChildToKeep",
      type: "expense",
      parent_id: parentData.id,
    });

    const result = await callTool("delete_category", { id: parentData.id });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("child category");
  });

  test("rejects deleting non-existent category", async () => {
    const result = await callTool("delete_category", {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Category not found");
  });
});
