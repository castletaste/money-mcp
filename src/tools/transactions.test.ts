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

const TEST_SCHEMA = process.env.MCP_MONEY_SCHEMA!;
let sql: postgres.Sql;
let client: Client;
let server: ReturnType<typeof createMcpServer>;

// IDs populated in beforeAll
let expenseCategoryId: string;
let incomeCategoryId: string;

beforeAll(async () => {
  sql = postgres(process.env.DATABASE_URL!);
  await migrate(sql);
  await seed(sql);

  const db = drizzle(sql, { schema: schemaExports });
  server = createMcpServer();
  registerCategoryTools(server, db);
  registerTagTools(server, db);
  registerTransactionTools(server, db);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  // Get a seeded expense category (Groceries)
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

describe("add_transaction", () => {
  test("adds an expense with negative amount", async () => {
    const result = await callTool("add_transaction", {
      amount: 42.5,
      category_id: expenseCategoryId,
      description: "Weekly groceries",
      date: "2026-03-01T12:00:00Z",
    });
    const tx = parseText(result) as {
      id: string;
      amount: string;
      currency: string;
      description: string;
      categoryName: string;
    };
    expect(tx.id).toBeTruthy();
    expect(Number(tx.amount)).toBe(-42.5);
    expect(tx.currency).toBe("USD");
    expect(tx.description).toBe("Weekly groceries");
    expect(tx.categoryName).toBe("Groceries");
  });

  test("adds an income with positive amount", async () => {
    const result = await callTool("add_transaction", {
      amount: 5000,
      category_id: incomeCategoryId,
      description: "March salary",
      date: "2026-03-01T12:00:00Z",
    });
    const tx = parseText(result) as { amount: string; categoryName: string };
    expect(Number(tx.amount)).toBe(5000);
    expect(tx.categoryName).toBe("Salary");
  });

  test("creates tags on-the-fly", async () => {
    const result = await callTool("add_transaction", {
      amount: 15,
      category_id: expenseCategoryId,
      description: "Lunch with tag",
      date: "2026-03-02T12:00:00Z",
      tags: ["lunch", "work"],
    });
    const tx = parseText(result) as {
      id: string;
      tags: Array<{ id: string; name: string }>;
    };
    expect(tx.tags.length).toBe(2);
    expect(tx.tags.map((t) => t.name).sort()).toEqual(["lunch", "work"]);

    // Verify tags were actually created
    const tagsResult = await callTool("list_tags");
    const allTags = parseText(tagsResult) as Array<{ name: string }>;
    expect(allTags.some((t) => t.name === "lunch")).toBe(true);
    expect(allTags.some((t) => t.name === "work")).toBe(true);
  });

  test("reuses existing tags", async () => {
    await callTool("create_tag", { name: "reuse-me" });
    const result = await callTool("add_transaction", {
      amount: 10,
      category_id: expenseCategoryId,
      description: "With existing tag",
      date: "2026-03-02T12:00:00Z",
      tags: ["reuse-me"],
    });
    const tx = parseText(result) as {
      tags: Array<{ name: string }>;
    };
    expect(tx.tags.length).toBe(1);
    expect(tx.tags[0].name).toBe("reuse-me");
  });

  test("uses default currency when not specified", async () => {
    const result = await callTool("add_transaction", {
      amount: 20,
      category_id: expenseCategoryId,
      description: "Default currency test",
      date: "2026-03-03T12:00:00Z",
    });
    const tx = parseText(result) as { currency: string };
    expect(tx.currency).toBe("USD");
  });

  test("uses specified currency", async () => {
    const result = await callTool("add_transaction", {
      amount: 100,
      currency: "EUR",
      category_id: expenseCategoryId,
      description: "Euro expense",
      date: "2026-03-03T12:00:00Z",
    });
    const tx = parseText(result) as { currency: string };
    expect(tx.currency).toBe("EUR");
  });

  test("rejects invalid category_id", async () => {
    const result = await callTool("add_transaction", {
      amount: 10,
      category_id: "00000000-0000-0000-0000-000000000000",
      description: "Bad category",
      date: "2026-03-03T12:00:00Z",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Category not found");
  });

  test("stores metadata", async () => {
    const result = await callTool("add_transaction", {
      amount: 30,
      category_id: expenseCategoryId,
      description: "With metadata",
      date: "2026-03-03T12:00:00Z",
      metadata: { store: "Whole Foods", receipt: "abc123" },
    });
    const tx = parseText(result) as { metadata: Record<string, unknown> };
    expect(tx.metadata).toEqual({ store: "Whole Foods", receipt: "abc123" });
  });

  test("adds transaction without category (expense by default)", async () => {
    const result = await callTool("add_transaction", {
      amount: 5,
      description: "No category",
      date: "2026-03-03T12:00:00Z",
    });
    const tx = parseText(result) as {
      amount: string;
      categoryId: string | null;
    };
    // Without category, defaults to expense (negative)
    expect(Number(tx.amount)).toBe(-5);
    expect(tx.categoryId).toBeNull();
  });
});

describe("list_transactions", () => {
  test("lists all transactions", async () => {
    const result = await callTool("list_transactions");
    const txs = parseText(result) as Array<{ id: string }>;
    expect(txs.length).toBeGreaterThan(0);
  });

  test("filters by date range", async () => {
    const result = await callTool("list_transactions", {
      date_from: "2026-03-01T00:00:00Z",
      date_to: "2026-03-01T23:59:59Z",
    });
    const txs = parseText(result) as Array<{ date: string }>;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      const d = new Date(tx.date);
      expect(d.getTime()).toBeGreaterThanOrEqual(
        new Date("2026-03-01T00:00:00Z").getTime(),
      );
      expect(d.getTime()).toBeLessThanOrEqual(
        new Date("2026-03-01T23:59:59Z").getTime(),
      );
    }
  });

  test("filters by category", async () => {
    const result = await callTool("list_transactions", {
      category_id: incomeCategoryId,
    });
    const txs = parseText(result) as Array<{ categoryName: string }>;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.categoryName).toBe("Salary");
    }
  });

  test("filters by tag", async () => {
    const result = await callTool("list_transactions", {
      tag: "lunch",
    });
    const txs = parseText(result) as Array<{
      tags: Array<{ name: string }>;
    }>;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.tags.some((t) => t.name === "lunch")).toBe(true);
    }
  });

  test("filters by currency", async () => {
    const result = await callTool("list_transactions", {
      currency: "EUR",
    });
    const txs = parseText(result) as Array<{ currency: string }>;
    expect(txs.length).toBeGreaterThan(0);
    for (const tx of txs) {
      expect(tx.currency).toBe("EUR");
    }
  });

  test("supports limit and offset", async () => {
    const all = await callTool("list_transactions");
    const allTxs = parseText(all) as Array<{ id: string }>;

    const limited = await callTool("list_transactions", { limit: 2 });
    const limitedTxs = parseText(limited) as Array<{ id: string }>;
    expect(limitedTxs.length).toBe(2);

    const offset = await callTool("list_transactions", {
      limit: 2,
      offset: 2,
    });
    const offsetTxs = parseText(offset) as Array<{ id: string }>;
    // Should not overlap with the first page
    expect(offsetTxs[0].id).not.toBe(limitedTxs[0].id);
    expect(offsetTxs[0].id).not.toBe(limitedTxs[1].id);
  });

  test("returns empty for non-existent tag", async () => {
    const result = await callTool("list_transactions", {
      tag: "nonexistent-tag-xyz",
    });
    const txs = parseText(result) as Array<unknown>;
    expect(txs.length).toBe(0);
  });

  test("returns transactions with category name and tags", async () => {
    const result = await callTool("list_transactions", { tag: "work" });
    const txs = parseText(result) as Array<{
      categoryName: string;
      tags: Array<{ name: string }>;
    }>;
    expect(txs.length).toBeGreaterThan(0);
    expect(txs[0].categoryName).toBeTruthy();
    expect(txs[0].tags.length).toBeGreaterThan(0);
  });
});

describe("update_transaction", () => {
  let txId: string;

  test("setup: create a transaction to update", async () => {
    const result = await callTool("add_transaction", {
      amount: 25,
      category_id: expenseCategoryId,
      description: "To be updated",
      date: "2026-03-05T12:00:00Z",
      tags: ["original-tag"],
    });
    const tx = parseText(result) as { id: string };
    txId = tx.id;
  });

  test("updates description", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      description: "Updated description",
    });
    const tx = parseText(result) as { description: string };
    expect(tx.description).toBe("Updated description");
  });

  test("updates amount with sign convention", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      amount: 50,
    });
    const tx = parseText(result) as { amount: string };
    expect(Number(tx.amount)).toBe(-50); // expense category = negative
  });

  test("updates currency", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      currency: "GBP",
    });
    const tx = parseText(result) as { currency: string };
    expect(tx.currency).toBe("GBP");
  });

  test("updates tags (replace all)", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      tags: ["new-tag-1", "new-tag-2"],
    });
    const tx = parseText(result) as {
      tags: Array<{ name: string }>;
    };
    expect(tx.tags.length).toBe(2);
    expect(tx.tags.map((t) => t.name).sort()).toEqual([
      "new-tag-1",
      "new-tag-2",
    ]);
  });

  test("clears tags when empty array", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      tags: [],
    });
    const tx = parseText(result) as {
      tags: Array<{ name: string }>;
    };
    expect(tx.tags.length).toBe(0);
  });

  test("changes category and re-signs amount", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      category_id: incomeCategoryId,
    });
    const tx = parseText(result) as {
      amount: string;
      categoryName: string;
    };
    expect(tx.categoryName).toBe("Salary");
    // Amount should now be positive (income)
    expect(Number(tx.amount)).toBe(50);
  });

  test("rejects non-existent transaction", async () => {
    const result = await callTool("update_transaction", {
      id: "00000000-0000-0000-0000-000000000000",
      description: "nope",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Transaction not found");
  });

  test("rejects non-existent category", async () => {
    const result = await callTool("update_transaction", {
      id: txId,
      category_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Category not found");
  });
});

describe("delete_transaction", () => {
  test("deletes a transaction", async () => {
    // Create one to delete
    const created = await callTool("add_transaction", {
      amount: 10,
      category_id: expenseCategoryId,
      description: "To delete",
      date: "2026-03-06T12:00:00Z",
      tags: ["delete-test"],
    });
    const tx = parseText(created) as { id: string };

    const result = await callTool("delete_transaction", { id: tx.id });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("Deleted transaction");
    expect(getText(result)).toContain(tx.id);

    // Verify gone
    const list = await callTool("list_transactions");
    const txs = parseText(list) as Array<{ id: string }>;
    expect(txs.some((t) => t.id === tx.id)).toBe(false);
  });

  test("removes tag associations on delete", async () => {
    const created = await callTool("add_transaction", {
      amount: 5,
      category_id: expenseCategoryId,
      description: "Delete with tags",
      date: "2026-03-06T12:00:00Z",
      tags: ["persist-tag"],
    });
    const tx = parseText(created) as { id: string };

    await callTool("delete_transaction", { id: tx.id });

    // Verify transaction_tags are gone
    const rows = await sql.unsafe(
      `SELECT COUNT(*) as cnt FROM "${TEST_SCHEMA}".transaction_tags WHERE transaction_id = $1`,
      [tx.id],
    );
    expect(Number(rows[0].cnt)).toBe(0);

    // But the tag itself should still exist
    const tagResult = await callTool("list_tags");
    const allTags = parseText(tagResult) as Array<{ name: string }>;
    expect(allTags.some((t) => t.name === "persist-tag")).toBe(true);
  });

  test("rejects non-existent transaction", async () => {
    const result = await callTool("delete_transaction", {
      id: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Transaction not found");
  });
});
