import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schemaExports from "../db/schema.js";
import { migrate } from "../db/migrate.js";
import { seed } from "../db/seed.js";
import { createMcpServer } from "../server.js";
import { registerTransactionTools } from "./transactions.js";
import { registerCategoryTools } from "./categories.js";
import { registerTagTools } from "./tags.js";
import { registerSummaryTools } from "./summary.js";

const TEST_SCHEMA = process.env.MCP_MONEY_SCHEMA!;
let sql: postgres.Sql;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

let expenseCategoryId: string;
let incomeCategoryId: string;
let transportCategoryId: string;

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

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  // Get seeded categories
  const catResult = await callTool("list_categories");
  const groups = parseText(catResult) as Array<{
    type: string;
    categories: Array<{ id: string; name: string }>;
  }>;
  const expenseGroup = groups.find((g) => g.type === "expense")!;
  const incomeGroup = groups.find((g) => g.type === "income")!;
  expenseCategoryId = expenseGroup.categories.find(
    (c) => c.name === "Groceries",
  )!.id;
  incomeCategoryId = incomeGroup.categories.find(
    (c) => c.name === "Salary",
  )!.id;
  transportCategoryId = expenseGroup.categories.find(
    (c) => c.name === "Transport",
  )!.id;

  // Create test transactions
  // March 2026: 2 grocery expenses in USD, 1 transport expense in USD, 1 grocery in EUR, 1 income in USD
  await callTool("add_transaction", {
    amount: 50,
    category_id: expenseCategoryId,
    currency: "USD",
    description: "Groceries week 1",
    date: "2026-03-05T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 30,
    category_id: expenseCategoryId,
    currency: "USD",
    description: "Groceries week 2",
    date: "2026-03-12T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 20,
    category_id: transportCategoryId,
    currency: "USD",
    description: "Bus pass",
    date: "2026-03-10T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 45,
    category_id: expenseCategoryId,
    currency: "EUR",
    description: "Groceries in Europe",
    date: "2026-03-15T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 5000,
    category_id: incomeCategoryId,
    currency: "USD",
    description: "March salary",
    date: "2026-03-01T12:00:00Z",
  });
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

interface SummaryResult {
  period: { from: string; to: string };
  categoryBreakdown: Array<{
    categoryId: string | null;
    categoryName: string | null;
    categoryType: string | null;
    currency: string;
    total: string;
    count: number;
    average: string;
  }>;
  totals: Array<{
    currency: string;
    income: string;
    expenses: string;
    net: string;
    count: number;
  }>;
}

describe("get_summary", () => {
  test("returns summary with category breakdown for date range", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
    });
    const summary = parseText(result) as SummaryResult;

    expect(summary.period.from).toBe("2026-03-01T00:00:00Z");
    expect(summary.period.to).toBe("2026-03-31T23:59:59Z");
    expect(summary.categoryBreakdown.length).toBeGreaterThan(0);
    expect(summary.totals.length).toBeGreaterThan(0);
  });

  test("groups by currency without cross-currency conversion", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
    });
    const summary = parseText(result) as SummaryResult;

    const usdTotal = summary.totals.find((t) => t.currency === "USD");
    const eurTotal = summary.totals.find((t) => t.currency === "EUR");

    expect(usdTotal).toBeDefined();
    expect(eurTotal).toBeDefined();

    // USD: income 5000, expenses -50 + -30 + -20 = -100
    expect(Number(usdTotal!.income)).toBe(5000);
    expect(Number(usdTotal!.expenses)).toBe(-100);
    expect(Number(usdTotal!.net)).toBe(4900);

    // EUR: expenses -45
    expect(Number(eurTotal!.income)).toBe(0);
    expect(Number(eurTotal!.expenses)).toBe(-45);
    expect(Number(eurTotal!.net)).toBe(-45);
  });

  test("category breakdown includes correct totals and averages", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
    });
    const summary = parseText(result) as SummaryResult;

    // Find Groceries USD breakdown
    const groceriesUsd = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Groceries" && b.currency === "USD",
    );
    expect(groceriesUsd).toBeDefined();
    expect(Number(groceriesUsd!.total)).toBe(-80); // -50 + -30
    expect(groceriesUsd!.count).toBe(2);
    expect(Number(groceriesUsd!.average)).toBe(-40); // -80 / 2

    // Find Transport USD breakdown
    const transportUsd = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Transport" && b.currency === "USD",
    );
    expect(transportUsd).toBeDefined();
    expect(Number(transportUsd!.total)).toBe(-20);
    expect(transportUsd!.count).toBe(1);

    // Find Groceries EUR breakdown
    const groceriesEur = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Groceries" && b.currency === "EUR",
    );
    expect(groceriesEur).toBeDefined();
    expect(Number(groceriesEur!.total)).toBe(-45);
    expect(groceriesEur!.count).toBe(1);
  });

  test("filters by category_id", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
      category_id: expenseCategoryId,
    });
    const summary = parseText(result) as SummaryResult;

    // Only Groceries transactions should appear
    for (const b of summary.categoryBreakdown) {
      expect(b.categoryName).toBe("Groceries");
    }

    // Should have USD and EUR entries
    expect(summary.categoryBreakdown.length).toBe(2);
  });

  test("returns empty results for period with no transactions", async () => {
    const result = await callTool("get_summary", {
      date_from: "2020-01-01T00:00:00Z",
      date_to: "2020-01-31T23:59:59Z",
    });
    const summary = parseText(result) as SummaryResult;

    expect(summary.categoryBreakdown.length).toBe(0);
    expect(summary.totals.length).toBe(0);
  });

  test("category breakdown includes category type", async () => {
    const result = await callTool("get_summary", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-31T23:59:59Z",
    });
    const summary = parseText(result) as SummaryResult;

    const incomeEntry = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Salary",
    );
    expect(incomeEntry).toBeDefined();
    expect(incomeEntry!.categoryType).toBe("income");

    const expenseEntry = summary.categoryBreakdown.find(
      (b) => b.categoryName === "Groceries",
    );
    expect(expenseEntry).toBeDefined();
    expect(expenseEntry!.categoryType).toBe("expense");
  });
});
