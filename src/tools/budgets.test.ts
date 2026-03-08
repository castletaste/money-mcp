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
import { registerTagTools } from "./tags.js";
import { registerTransactionTools } from "./transactions.js";
import { registerSummaryTools } from "./summary.js";
import { registerBudgetTools } from "./budgets.js";

const TEST_SCHEMA = process.env.MCP_MONEY_SCHEMA!;
let sql: postgres.Sql;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

let expenseCategoryId: string;
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
  registerBudgetTools(server, db);

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
  expenseCategoryId = expenseGroup.categories.find(
    (c) => c.name === "Groceries",
  )!.id;
  transportCategoryId = expenseGroup.categories.find(
    (c) => c.name === "Transport",
  )!.id;

  // Create test transactions for March 2026
  await callTool("add_transaction", {
    amount: 150,
    category_id: expenseCategoryId,
    currency: "USD",
    description: "Big grocery run",
    date: "2026-03-10T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 50,
    category_id: expenseCategoryId,
    currency: "USD",
    description: "Small grocery run",
    date: "2026-03-15T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 30,
    category_id: expenseCategoryId,
    currency: "EUR",
    description: "Euro groceries",
    date: "2026-03-20T12:00:00Z",
  });
  await callTool("add_transaction", {
    amount: 40,
    category_id: transportCategoryId,
    currency: "USD",
    description: "Taxi",
    date: "2026-03-12T12:00:00Z",
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

describe("set_budget", () => {
  test("creates a new budget for a category", async () => {
    const result = await callTool("set_budget", {
      category_id: expenseCategoryId,
      amount: 500,
      start_date: "2026-03-01",
    });
    const budget = parseText(result) as any;

    expect(budget._action).toBe("created");
    expect(budget.id).toBeDefined();
    expect(budget.categoryId).toBe(expenseCategoryId);
    expect(Number(budget.amount)).toBe(500);
    expect(budget.period).toBe("monthly");
    expect(budget.startDate).toBe("2026-03-01");
  });

  test("updates existing budget for same category + start_date", async () => {
    const result = await callTool("set_budget", {
      category_id: expenseCategoryId,
      amount: 600,
      start_date: "2026-03-01",
    });
    const budget = parseText(result) as any;

    expect(budget._action).toBe("updated");
    expect(Number(budget.amount)).toBe(600);
  });

  test("creates separate budget for different month", async () => {
    const result = await callTool("set_budget", {
      category_id: expenseCategoryId,
      amount: 700,
      start_date: "2026-04-01",
    });
    const budget = parseText(result) as any;

    expect(budget._action).toBe("created");
    expect(budget.startDate).toBe("2026-04-01");
    expect(Number(budget.amount)).toBe(700);
  });

  test("errors for non-existent category", async () => {
    const result = await callTool("set_budget", {
      category_id: "00000000-0000-0000-0000-000000000000",
      amount: 100,
      start_date: "2026-03-01",
    });

    expect(result.isError).toBe(true);
  });
});

describe("get_budget_status", () => {
  let transportBudgetId: string;

  test("returns budget status with actual spending", async () => {
    const result = await callTool("get_budget_status", {
      month: "2026-03",
    });
    const status = parseText(result) as any;

    expect(status.month).toBe("2026-03");
    expect(status.budgets.length).toBeGreaterThan(0);

    // Find the groceries budget
    const groceryBudget = status.budgets.find(
      (b: any) => b.categoryId === expenseCategoryId,
    );
    expect(groceryBudget).toBeDefined();
    expect(Number(groceryBudget.budgetAmount)).toBe(600); // updated amount
    expect(groceryBudget.categoryName).toBe("Groceries");

    // Should have USD spending entry
    const usdEntry = groceryBudget.currencies.find(
      (c: any) => c.currency === "USD",
    );
    expect(usdEntry).toBeDefined();
    expect(Number(usdEntry.spent)).toBe(200); // 150 + 50
    expect(Number(usdEntry.remaining)).toBe(400); // 600 - 200
    expect(usdEntry.overBudget).toBe(false);
  });

  test("shows multi-currency spending separately", async () => {
    const result = await callTool("get_budget_status", {
      month: "2026-03",
      category_id: expenseCategoryId,
    });
    const status = parseText(result) as any;

    const groceryBudget = status.budgets[0];
    const eurEntry = groceryBudget.currencies.find(
      (c: any) => c.currency === "EUR",
    );
    expect(eurEntry).toBeDefined();
    expect(Number(eurEntry.spent)).toBe(30);
  });

  test("returns empty budgets for month with no budgets", async () => {
    const result = await callTool("get_budget_status", {
      month: "2020-01",
    });
    const status = parseText(result) as any;

    expect(status.budgets).toEqual([]);
    expect(status.message).toBe("No budgets found");
  });

  test("filters by category_id", async () => {
    // Set a transport budget
    const setBudgetResult = await callTool("set_budget", {
      category_id: transportCategoryId,
      amount: 100,
      start_date: "2026-03-01",
    });
    transportBudgetId = (parseText(setBudgetResult) as any).id;

    const result = await callTool("get_budget_status", {
      month: "2026-03",
      category_id: transportCategoryId,
    });
    const status = parseText(result) as any;

    expect(status.budgets.length).toBe(1);
    expect(status.budgets[0].categoryName).toBe("Transport");
    expect(Number(status.budgets[0].currencies[0].spent)).toBe(40);
  });

  test("detects over-budget spending", async () => {
    // Set a small budget for transport: 20, but we already spent 40
    await callTool("set_budget", {
      category_id: transportCategoryId,
      amount: 20,
      start_date: "2026-03-01",
    });

    const result = await callTool("get_budget_status", {
      month: "2026-03",
      category_id: transportCategoryId,
    });
    const status = parseText(result) as any;

    expect(status.budgets.length).toBe(1);
    const transportBudget = status.budgets[0];
    const usdEntry = transportBudget.currencies.find(
      (c: any) => c.currency === "USD",
    );
    expect(usdEntry).toBeDefined();
    expect(Number(usdEntry.spent)).toBe(40);
    expect(usdEntry.overBudget).toBe(true);
    expect(Number(usdEntry.remaining)).toBeLessThan(0);
  });

  test("shows zero spending when no transactions in period", async () => {
    const result = await callTool("get_budget_status", {
      month: "2026-04",
    });
    const status = parseText(result) as any;

    // April budget exists (700 for groceries)
    const aprilBudget = status.budgets.find(
      (b: any) => b.categoryId === expenseCategoryId,
    );
    expect(aprilBudget).toBeDefined();
    expect(aprilBudget.currencies[0].spent).toBe("0.0000");
    expect(aprilBudget.currencies[0].currency).toBe("N/A");
  });
});

describe("delete_budget", () => {
  test("deletes a budget by ID", async () => {
    // Create a budget to delete
    const createResult = await callTool("set_budget", {
      category_id: transportCategoryId,
      amount: 200,
      start_date: "2026-05-01",
    });
    const created = parseText(createResult) as any;

    const deleteResult = await callTool("delete_budget", {
      id: created.id,
    });
    const deleted = parseText(deleteResult) as any;

    expect(deleted.deleted).toBe(true);
    expect(deleted.id).toBe(created.id);

    // Verify it's gone - get_budget_status for May should not include it
    const statusResult = await callTool("get_budget_status", {
      month: "2026-05",
    });
    const status = parseText(statusResult) as any;
    const found = status.budgets?.find((b: any) => b.budgetId === created.id);
    expect(found).toBeUndefined();
  });

  test("errors for non-existent budget", async () => {
    const result = await callTool("delete_budget", {
      id: "00000000-0000-0000-0000-000000000000",
    });

    expect(result.isError).toBe(true);
  });
});
