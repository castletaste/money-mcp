import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import { categories, transactions, budgets } from "../db/schema.js";

export function registerCategoryTools(server: McpServer, db: Database) {
  // --- list_categories ---
  server.tool(
    "list_categories",
    "List all categories grouped by type (expense/income), with parent info",
    {},
    async () => {
      try {
        const rows = await db
          .select({
            id: categories.id,
            name: categories.name,
            type: categories.type,
            parentId: categories.parentId,
            createdAt: categories.createdAt,
          })
          .from(categories)
          .orderBy(categories.type, categories.name);

        // Build parent name lookup
        const byId = new Map(rows.map((r) => [r.id, r]));

        const grouped: Record<string, typeof rows> = {};
        for (const row of rows) {
          if (!grouped[row.type]) grouped[row.type] = [];
          grouped[row.type].push(row);
        }

        const result = Object.entries(grouped).map(([type, cats]) => ({
          type,
          categories: cats.map((c) => ({
            id: c.id,
            name: c.name,
            parentId: c.parentId ?? null,
            parentName: c.parentId
              ? (byId.get(c.parentId)?.name ?? null)
              : null,
          })),
        }));

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `list_categories failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // --- create_category ---
  server.tool(
    "create_category",
    "Create a new category with a name, type (expense/income), and optional parent_id (one nesting level max)",
    {
      name: z.string().min(1).max(255).describe("Category name"),
      type: z
        .enum(["expense", "income"])
        .describe("Category type: expense or income"),
      parent_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional parent category ID (one nesting level max)"),
    },
    async ({ name, type, parent_id }) => {
      try {
        // Validate parent if provided
        if (parent_id) {
          const parent = await db
            .select({ id: categories.id, parentId: categories.parentId })
            .from(categories)
            .where(eq(categories.id, parent_id));

          if (parent.length === 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Parent category not found: ${parent_id}`,
                },
              ],
            };
          }

          // Enforce one nesting level: parent must not have a parent itself
          if (parent[0].parentId) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Cannot nest more than one level deep. The specified parent already has a parent.",
                },
              ],
            };
          }
        }

        const id = uuidv7();
        const inserted = await db
          .insert(categories)
          .values({ id, name, type, parentId: parent_id ?? null })
          .onConflictDoNothing({ target: categories.name })
          .returning({ id: categories.id });

        if (inserted.length === 0) {
          const existing = await db
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.name, name));
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Category with name "${name}" already exists (id: ${existing[0]?.id ?? "unknown"})`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: inserted[0].id,
                name,
                type,
                parentId: parent_id ?? null,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `create_category failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // --- delete_category ---
  server.tool(
    "delete_category",
    "Delete a category. Fails if transactions, budgets, or child categories reference it.",
    {
      id: z.string().uuid().describe("Category ID to delete"),
    },
    async ({ id }) => {
      try {
        // Check if category exists
        const cat = await db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(eq(categories.id, id));

        if (cat.length === 0) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: `Category not found: ${id}` },
            ],
          };
        }

        // Check for referencing transactions (RESTRICT)
        const txCount = await db
          .select({ count: count() })
          .from(transactions)
          .where(eq(transactions.categoryId, id));

        const txRefCount = Number(txCount[0]?.count ?? 0);
        if (txRefCount > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Cannot delete category "${cat[0].name}": ${txRefCount} transaction(s) still reference it. Remove or reassign them first.`,
              },
            ],
          };
        }

        // Check for referencing budgets
        const budgetCount = await db
          .select({ count: count() })
          .from(budgets)
          .where(eq(budgets.categoryId, id));

        const budgetRefCount = Number(budgetCount[0]?.count ?? 0);
        if (budgetRefCount > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Cannot delete category "${cat[0].name}": ${budgetRefCount} budget(s) still reference it. Delete them first.`,
              },
            ],
          };
        }

        // Also check for child categories
        const children = await db
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.parentId, id));

        if (children.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Cannot delete category "${cat[0].name}": it has ${children.length} child category/categories. Delete them first.`,
              },
            ],
          };
        }

        await db.delete(categories).where(eq(categories.id, id));

        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted category "${cat[0].name}" (${id})`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `delete_category failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
