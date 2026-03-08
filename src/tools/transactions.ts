import { z } from "zod";
import { eq, and, gte, lte, sql as dsql, desc, inArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import {
  transactions,
  transactionTags,
  categories,
  tags,
  settings,
} from "../db/schema.js";

async function getDefaultCurrency(db: Database): Promise<string> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "default_currency"));
  return row[0]?.value ?? "USD";
}

async function resolveTagIds(
  db: Database,
  tagNames: string[],
): Promise<string[]> {
  const tagIds: string[] = [];
  for (const name of tagNames) {
    const existing = await db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.name, name));
    if (existing.length > 0) {
      tagIds.push(existing[0].id);
    } else {
      const id = uuidv7();
      await db.insert(tags).values({ id, name });
      tagIds.push(id);
    }
  }
  return tagIds;
}

async function linkTags(
  db: Database,
  transactionId: string,
  tagIds: string[],
): Promise<void> {
  if (tagIds.length === 0) return;
  await db
    .insert(transactionTags)
    .values(tagIds.map((tagId) => ({ transactionId, tagId })));
}

async function fetchTransactionWithDetails(
  db: Database,
  txId: string,
): Promise<{
  id: string;
  amount: string;
  currency: string;
  description: string | null;
  date: Date;
  categoryId: string | null;
  categoryName: string | null;
  tags: Array<{ id: string; name: string }>;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}> {
  const rows = await db
    .select({
      id: transactions.id,
      amount: transactions.amount,
      currency: transactions.currency,
      description: transactions.description,
      date: transactions.date,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      metadata: transactions.metadata,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(eq(transactions.id, txId));

  const tx = rows[0];

  const tagRows = await db
    .select({ id: tags.id, name: tags.name })
    .from(transactionTags)
    .innerJoin(tags, eq(transactionTags.tagId, tags.id))
    .where(eq(transactionTags.transactionId, txId));

  return { ...tx, tags: tagRows };
}

export function registerTransactionTools(server: McpServer, db: Database) {
  // --- add_transaction ---
  server.tool(
    "add_transaction",
    "Record an expense or income transaction. Expenses are stored with negative amount. Tags are created on-the-fly if they don't exist.",
    {
      amount: z
        .number()
        .positive()
        .describe(
          "Transaction amount (always positive; sign is determined by category type)",
        ),
      currency: z
        .string()
        .optional()
        .describe("Currency code (defaults to user's default currency)"),
      category_id: z.string().uuid().optional().describe("Category ID"),
      description: z.string().optional().describe("Transaction description"),
      date: z
        .string()
        .optional()
        .describe("Transaction date (ISO 8601, defaults to now)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tag names (created on-the-fly if not existing)"),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Arbitrary JSON metadata"),
    },
    async (params) => {
      // Resolve currency
      const currency = params.currency
        ? params.currency.toUpperCase()
        : await getDefaultCurrency(db);

      // Resolve category and determine sign
      let categoryType: string | null = null;
      if (params.category_id) {
        const cat = await db
          .select({ id: categories.id, type: categories.type })
          .from(categories)
          .where(eq(categories.id, params.category_id));

        if (cat.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Category not found: ${params.category_id}`,
              },
            ],
          };
        }
        categoryType = cat[0].type;
      }

      // Expense = negative, income = positive
      const signedAmount =
        categoryType === "income" ? params.amount : -params.amount;

      const txDate = params.date ? new Date(params.date) : new Date();
      const id = uuidv7();

      await db.insert(transactions).values({
        id,
        categoryId: params.category_id ?? null,
        amount: signedAmount.toFixed(4),
        currency,
        description: params.description ?? null,
        date: txDate,
        metadata: params.metadata ?? {},
      });

      // Resolve and link tags
      if (params.tags && params.tags.length > 0) {
        const tagIds = await resolveTagIds(db, params.tags);
        await linkTags(db, id, tagIds);
      }

      const result = await fetchTransactionWithDetails(db, id);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // --- list_transactions ---
  server.tool(
    "list_transactions",
    "List transactions with optional filters: date range, category, tag, currency. Supports pagination with limit/offset.",
    {
      date_from: z
        .string()
        .optional()
        .describe("Start date (ISO 8601, inclusive)"),
      date_to: z.string().optional().describe("End date (ISO 8601, inclusive)"),
      category_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter by category ID"),
      tag: z.string().optional().describe("Filter by tag name"),
      currency: z.string().optional().describe("Filter by currency code"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max number of results (default 50)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of results to skip (default 0)"),
    },
    async (params) => {
      const conditions = [];

      if (params.date_from) {
        conditions.push(gte(transactions.date, new Date(params.date_from)));
      }
      if (params.date_to) {
        conditions.push(lte(transactions.date, new Date(params.date_to)));
      }
      if (params.category_id) {
        conditions.push(eq(transactions.categoryId, params.category_id));
      }
      if (params.currency) {
        conditions.push(eq(transactions.currency, params.currency));
      }

      // If filtering by tag, get transaction IDs that have the tag
      if (params.tag) {
        const tagRow = await db
          .select({ id: tags.id })
          .from(tags)
          .where(eq(tags.name, params.tag));

        if (tagRow.length === 0) {
          // Tag doesn't exist, return empty
          return {
            content: [
              { type: "text" as const, text: JSON.stringify([], null, 2) },
            ],
          };
        }

        const txIds = await db
          .select({ transactionId: transactionTags.transactionId })
          .from(transactionTags)
          .where(eq(transactionTags.tagId, tagRow[0].id));

        if (txIds.length === 0) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify([], null, 2) },
            ],
          };
        }

        conditions.push(
          inArray(
            transactions.id,
            txIds.map((r) => r.transactionId),
          ),
        );
      }

      const limit = params.limit ?? 50;
      const offset = params.offset ?? 0;

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          id: transactions.id,
          amount: transactions.amount,
          currency: transactions.currency,
          description: transactions.description,
          date: transactions.date,
          categoryId: transactions.categoryId,
          categoryName: categories.name,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .leftJoin(categories, eq(transactions.categoryId, categories.id))
        .where(whereClause)
        .orderBy(desc(transactions.date), desc(transactions.id))
        .limit(limit)
        .offset(offset);

      // Fetch tags for all transactions in batch
      const txIds = rows.map((r) => r.id);
      let tagsByTxId: Map<
        string,
        Array<{ id: string; name: string }>
      > = new Map();

      if (txIds.length > 0) {
        const allTags = await db
          .select({
            transactionId: transactionTags.transactionId,
            tagId: tags.id,
            tagName: tags.name,
          })
          .from(transactionTags)
          .innerJoin(tags, eq(transactionTags.tagId, tags.id))
          .where(inArray(transactionTags.transactionId, txIds));

        for (const t of allTags) {
          if (!tagsByTxId.has(t.transactionId)) {
            tagsByTxId.set(t.transactionId, []);
          }
          tagsByTxId
            .get(t.transactionId)!
            .push({ id: t.tagId, name: t.tagName });
        }
      }

      const result = rows.map((r) => ({
        ...r,
        tags: tagsByTxId.get(r.id) ?? [],
      }));

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // --- update_transaction ---
  server.tool(
    "update_transaction",
    "Update a transaction. Supports partial updates of any field including tags.",
    {
      id: z.string().uuid().describe("Transaction ID to update"),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("New amount (positive; sign determined by category type)"),
      currency: z.string().optional().describe("New currency code"),
      category_id: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe("New category ID (null to remove category)"),
      description: z.string().nullable().optional().describe("New description"),
      date: z.string().optional().describe("New date (ISO 8601)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Replace all tags with these tag names"),
      metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Replace metadata"),
    },
    async (params) => {
      // Check transaction exists
      const existing = await db
        .select({
          id: transactions.id,
          categoryId: transactions.categoryId,
          amount: transactions.amount,
        })
        .from(transactions)
        .where(eq(transactions.id, params.id));

      if (existing.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Transaction not found: ${params.id}`,
            },
          ],
        };
      }

      const updates: Record<string, unknown> = {};

      // Determine category for sign convention
      const effectiveCategoryId =
        params.category_id !== undefined
          ? params.category_id
          : existing[0].categoryId;

      if (params.amount !== undefined || params.category_id !== undefined) {
        let categoryType: string | null = null;
        if (effectiveCategoryId) {
          const cat = await db
            .select({ type: categories.type })
            .from(categories)
            .where(eq(categories.id, effectiveCategoryId));
          if (cat.length === 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Category not found: ${effectiveCategoryId}`,
                },
              ],
            };
          }
          categoryType = cat[0].type;
        }

        if (params.amount !== undefined) {
          const signedAmount =
            categoryType === "income" ? params.amount : -params.amount;
          updates.amount = signedAmount.toFixed(4);
        } else if (params.category_id !== undefined) {
          // Category changed but amount not provided - re-sign the existing amount
          const absAmount = Math.abs(Number(existing[0].amount));
          const signedAmount =
            categoryType === "income" ? absAmount : -absAmount;
          updates.amount = signedAmount.toFixed(4);
        }
      }

      if (params.category_id !== undefined) {
        updates.categoryId = params.category_id;
      }
      if (params.currency !== undefined) {
        updates.currency = params.currency;
      }
      if (params.description !== undefined) {
        updates.description = params.description;
      }
      if (params.date !== undefined) {
        updates.date = new Date(params.date);
      }
      if (params.metadata !== undefined) {
        updates.metadata = params.metadata;
      }

      const hasFieldUpdates = Object.keys(updates).length > 0;
      const hasTagUpdates = params.tags !== undefined;

      if (hasFieldUpdates || hasTagUpdates) {
        updates.updatedAt = new Date();
      }

      if (Object.keys(updates).length > 0) {
        await db
          .update(transactions)
          .set(updates)
          .where(eq(transactions.id, params.id));
      }

      // Replace tags if provided
      if (params.tags !== undefined) {
        // Delete existing tag associations
        await db
          .delete(transactionTags)
          .where(eq(transactionTags.transactionId, params.id));

        if (params.tags.length > 0) {
          const tagIds = await resolveTagIds(db, params.tags);
          await linkTags(db, params.id, tagIds);
        }
      }

      const result = await fetchTransactionWithDetails(db, params.id);

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // --- delete_transaction ---
  server.tool(
    "delete_transaction",
    "Delete a transaction (hard delete). Associated tag links are removed via CASCADE.",
    {
      id: z.string().uuid().describe("Transaction ID to delete"),
    },
    async ({ id }) => {
      const tx = await db
        .select({
          id: transactions.id,
          description: transactions.description,
          amount: transactions.amount,
        })
        .from(transactions)
        .where(eq(transactions.id, id));

      if (tx.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Transaction not found: ${id}` },
          ],
        };
      }

      // Delete the transaction (transaction_tags cascade automatically via FK)
      await db.delete(transactions).where(eq(transactions.id, id));

      const desc = tx[0].description ? ` "${tx[0].description}"` : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted transaction${desc} (${id}, amount: ${tx[0].amount})`,
          },
        ],
      };
    },
  );
}
