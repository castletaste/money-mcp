import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schemaExports from "./db/schema.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { createMcpServer } from "./server.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerSummaryTools } from "./tools/summary.js";
import { registerBudgetTools } from "./tools/budgets.js";
import { registerUtilTools } from "./tools/utils.js";

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
  registerTagTools(server, db);
  registerTransactionTools(server, db);
  registerSummaryTools(server, db);
  registerBudgetTools(server, db);
  registerUtilTools(server, db);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "acceptance-test", version: "1.0.0" });
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

const ALL_16_TOOLS = [
  "list_categories",
  "create_category",
  "delete_category",
  "list_tags",
  "create_tag",
  "delete_tag",
  "add_transaction",
  "list_transactions",
  "update_transaction",
  "delete_transaction",
  "get_summary",
  "set_budget",
  "get_budget_status",
  "delete_budget",
  "set_currency",
  "health_check",
];

describe("acceptance: all 16 tools registered", () => {
  test("lists exactly 16 tools with correct names", async () => {
    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([...ALL_16_TOOLS].sort());
    expect(result.tools.length).toBe(16);
  });

  test("every tool has a description and input schema", async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

describe("acceptance: auto-migration on clean database", () => {
  test("migration is idempotent on already-migrated schema", async () => {
    // Running migrate again should not throw
    await migrate(sql);
    // Verify schema_version exists and has correct version
    const rows = await sql.unsafe(
      `SELECT version FROM "${TEST_SCHEMA}".schema_version ORDER BY applied_at DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0].version)).toBe(2);
  });

  test("migration creates all expected tables", async () => {
    const tables = await sql.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [TEST_SCHEMA],
    );
    const tableNames = tables
      .map((t: { table_name: string }) => t.table_name)
      .sort();
    expect(tableNames).toContain("categories");
    expect(tableNames).toContain("tags");
    expect(tableNames).toContain("transactions");
    expect(tableNames).toContain("transaction_tags");
    expect(tableNames).toContain("budgets");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("schema_version");
  });
});

describe("acceptance: end-to-end MCP flow", () => {
  let categoryId: string;

  test("add a transaction via MCP", async () => {
    // Get a category first
    const cats = await callTool("list_categories");
    const groups = parseText(cats) as Array<{
      type: string;
      categories: Array<{ id: string; name: string }>;
    }>;
    const expenseGroup = groups.find((g) => g.type === "expense")!;
    categoryId = expenseGroup.categories.find(
      (c) => c.name === "Groceries",
    )!.id;

    const result = await callTool("add_transaction", {
      amount: 55.99,
      category_id: categoryId,
      description: "Acceptance test grocery run",
      date: "2026-03-20T10:00:00Z",
      currency: "USD",
      tags: ["acceptance-test"],
    });
    const tx = parseText(result) as {
      id: string;
      amount: string;
      currency: string;
      description: string;
      categoryName: string;
      tags: Array<{ name: string }>;
    };
    expect(tx.id).toBeTruthy();
    expect(Number(tx.amount)).toBe(-55.99);
    expect(tx.currency).toBe("USD");
    expect(tx.categoryName).toBe("Groceries");
    expect(tx.tags[0].name).toBe("acceptance-test");
  });

  test("list transactions and find the one we added", async () => {
    const result = await callTool("list_transactions", {
      tag: "acceptance-test",
    });
    const txs = parseText(result) as Array<{
      description: string;
      amount: string;
    }>;
    expect(txs.length).toBe(1);
    expect(txs[0].description).toBe("Acceptance test grocery run");
    expect(Number(txs[0].amount)).toBe(-55.99);
  });

  test("get summary includes our transaction", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
    });
    const summary = parseText(result) as {
      totals: Array<{ currency: string; expenses: string }>;
      categoryBreakdown: Array<{
        categoryName: string;
        currency: string;
        total: string;
      }>;
    };
    // USD totals should include our -55.99 expense
    const usdTotal = summary.totals.find((t) => t.currency === "USD");
    expect(usdTotal).toBeDefined();
    expect(Number(usdTotal!.expenses)).toBeLessThan(0);

    // Should have a Groceries/USD breakdown entry
    const groceriesUsd = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Groceries" && b.currency === "USD",
    );
    expect(groceriesUsd).toBeDefined();
  });

  test("health_check returns expected fields", async () => {
    const result = await callTool("health_check");
    const health = parseText(result) as {
      status: string;
      schema_version: number;
      transaction_count: number;
      category_count: number;
    };
    expect(health.status).toBe("ok");
    expect(health.schema_version).toBe(2);
    expect(health.transaction_count).toBeGreaterThan(0);
    expect(health.category_count).toBeGreaterThan(0);
  });
});

describe("acceptance: multi-currency", () => {
  let expenseCatId: string;
  let incomeCatId: string;

  test("setup categories", async () => {
    const cats = await callTool("list_categories");
    const groups = parseText(cats) as Array<{
      type: string;
      categories: Array<{ id: string; name: string }>;
    }>;
    const expenseGroup = groups.find((g) => g.type === "expense")!;
    const incomeGroup = groups.find((g) => g.type === "income")!;
    expenseCatId = expenseGroup.categories.find(
      (c) => c.name === "Restaurants",
    )!.id;
    incomeCatId = incomeGroup.categories.find((c) => c.name === "Salary")!.id;
  });

  test("add USD and EUR transactions", async () => {
    const usdResult = await callTool("add_transaction", {
      amount: 75,
      category_id: expenseCatId,
      currency: "USD",
      description: "Dinner in NYC",
      date: "2026-04-10T19:00:00Z",
      tags: ["multicurrency-test"],
    });
    const usdTx = parseText(usdResult) as { currency: string; amount: string };
    expect(usdTx.currency).toBe("USD");
    expect(Number(usdTx.amount)).toBe(-75);

    const eurResult = await callTool("add_transaction", {
      amount: 60,
      category_id: expenseCatId,
      currency: "EUR",
      description: "Dinner in Paris",
      date: "2026-04-12T20:00:00Z",
      tags: ["multicurrency-test"],
    });
    const eurTx = parseText(eurResult) as { currency: string; amount: string };
    expect(eurTx.currency).toBe("EUR");
    expect(Number(eurTx.amount)).toBe(-60);

    // Also add an income in USD
    const incResult = await callTool("add_transaction", {
      amount: 3000,
      category_id: incomeCatId,
      currency: "USD",
      description: "Freelance April",
      date: "2026-04-01T09:00:00Z",
      tags: ["multicurrency-test"],
    });
    const incTx = parseText(incResult) as { currency: string; amount: string };
    expect(incTx.currency).toBe("USD");
    expect(Number(incTx.amount)).toBe(3000);
  });

  test("summary groups by currency without cross-conversion", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-04-01T00:00:00Z",
      date_to: "2026-04-30T23:59:59Z",
    });
    const summary = parseText(result) as {
      totals: Array<{
        currency: string;
        income: string;
        expenses: string;
        net: string;
      }>;
      categoryBreakdown: Array<{
        categoryName: string;
        currency: string;
        total: string;
      }>;
    };

    // Should have separate USD and EUR totals
    const usdTotal = summary.totals.find((t) => t.currency === "USD");
    const eurTotal = summary.totals.find((t) => t.currency === "EUR");

    expect(usdTotal).toBeDefined();
    expect(eurTotal).toBeDefined();

    // USD: income 3000, expense -75, net 2925
    expect(Number(usdTotal!.income)).toBe(3000);
    expect(Number(usdTotal!.expenses)).toBe(-75);
    expect(Number(usdTotal!.net)).toBe(2925);

    // EUR: income 0, expense -60, net -60
    expect(Number(eurTotal!.income)).toBe(0);
    expect(Number(eurTotal!.expenses)).toBe(-60);
    expect(Number(eurTotal!.net)).toBe(-60);
  });

  test("category breakdown separates currencies", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-04-01T00:00:00Z",
      date_to: "2026-04-30T23:59:59Z",
    });
    const summary = parseText(result) as {
      categoryBreakdown: Array<{
        categoryName: string;
        currency: string;
        total: string;
        count: number;
      }>;
    };

    const restaurantUsd = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Restaurants" && b.currency === "USD",
    );
    const restaurantEur = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Restaurants" && b.currency === "EUR",
    );

    expect(restaurantUsd).toBeDefined();
    expect(restaurantEur).toBeDefined();
    expect(Number(restaurantUsd!.total)).toBe(-75);
    expect(restaurantUsd!.count).toBe(1);
    expect(Number(restaurantEur!.total)).toBe(-60);
    expect(restaurantEur!.count).toBe(1);
  });
});
