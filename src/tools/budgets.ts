import { z } from "zod";
import { and, eq, gte, lt, inArray, sql as dsql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import { budgets, categories, transactions } from "../db/schema.js";
import { v7 as uuidv7 } from "uuid";
import { isValidISODate } from "../lib/dateUtils.js";

export function registerBudgetTools(server: McpServer, db: Database) {
  // --- set_budget ---
  server.tool(
    "set_budget",
    "Set or update a monthly budget for a category. If a budget already exists for the same category and start_date, it is updated.",
    {
      category_id: z.string().uuid().describe("Category ID to budget"),
      amount: z.number().positive().describe("Budget amount (positive number)"),
      start_date: z
        .string()
        .describe(
          "Budget start date (YYYY-MM-DD). Defines the month this budget applies to.",
        ),
    },
    async (params) => {
      // Verify category exists
      const [cat] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, params.category_id))
        .limit(1);

      if (!cat) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Category ${params.category_id} not found`,
            },
          ],
        };
      }

      // Reject non-date-only inputs (datetimes are not valid per tool contract)
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(params.start_date) ||
        !isValidISODate(params.start_date)
      ) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Invalid start_date: must be ISO 8601 (YYYY-MM-DD)",
            },
          ],
        };
      }
      // Normalize start_date to first of the month to enforce one budget per category per month
      const parsedDate = new Date(params.start_date);
      const normalizedStartDate = `${parsedDate.getUTCFullYear()}-${String(parsedDate.getUTCMonth() + 1).padStart(2, "0")}-01`;

      // Upsert: atomically create or update budget for this category/month
      const newId = uuidv7();
      const [row] = await db
        .insert(budgets)
        .values({
          id: newId,
          categoryId: params.category_id,
          amount: params.amount.toFixed(4),
          period: "monthly",
          startDate: normalizedStartDate,
        })
        .onConflictDoUpdate({
          target: [budgets.categoryId, budgets.startDate],
          set: { amount: params.amount.toFixed(4) },
        })
        .returning();

      const action = row.id === newId ? "created" : "updated";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...row, _action: action }, null, 2),
          },
        ],
      };
    },
  );

  // --- get_budget_status ---
  server.tool(
    "get_budget_status",
    "Check budget vs actual spending for a given month. Returns budget amount, actual spend, remaining, and percentage used. Multi-currency aware.",
    {
      month: z
        .string()
        .optional()
        .describe(
          "Month to check (YYYY-MM format). Defaults to current month.",
        ),
      category_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter by category ID"),
    },
    async (params) => {
      // Determine the month range
      let year: number;
      let month: number;

      if (params.month) {
        if (!/^\d{4}-\d{2}$/.test(params.month)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid month format: expected YYYY-MM",
              },
            ],
          };
        }
        const parts = params.month.split("-");
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        if (month < 1 || month > 12) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid month: must be between 01 and 12",
              },
            ],
          };
        }
      } else {
        const now = new Date();
        year = now.getUTCFullYear();
        month = now.getUTCMonth() + 1;
      }

      const monthStart = new Date(Date.UTC(year, month - 1, 1));
      const monthEnd = new Date(Date.UTC(year, month, 1));

      // Derive string boundaries from the Date objects
      const monthStartStr = monthStart.toISOString().slice(0, 10);
      const monthEndStr = monthEnd.toISOString().slice(0, 10);

      const budgetConditions = [
        gte(budgets.startDate, monthStartStr),
        lt(budgets.startDate, monthEndStr),
      ];
      if (params.category_id) {
        budgetConditions.push(eq(budgets.categoryId, params.category_id));
      }

      const budgetRows = await db
        .select({
          id: budgets.id,
          categoryId: budgets.categoryId,
          categoryName: categories.name,
          amount: budgets.amount,
          period: budgets.period,
          startDate: budgets.startDate,
        })
        .from(budgets)
        .innerJoin(categories, eq(budgets.categoryId, categories.id))
        .where(and(...budgetConditions));

      if (budgetRows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  month: `${year}-${String(month).padStart(2, "0")}`,
                  budgets: [],
                  message: "No budgets found",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Get actual spending for each budgeted category in the month
      const categoryIds = budgetRows.map((b) => b.categoryId);

      const spendingRows = await db
        .select({
          categoryId: transactions.categoryId,
          currency: transactions.currency,
          totalSpent: dsql<string>`sum(abs(${transactions.amount}))`,
        })
        .from(transactions)
        .where(
          and(
            inArray(transactions.categoryId, categoryIds),
            gte(transactions.date, monthStart),
            lt(transactions.date, monthEnd),
            lt(transactions.amount, "0"),
          ),
        )
        .groupBy(transactions.categoryId, transactions.currency);

      // Build spending lookup: categoryId -> currency -> totalSpent
      const spendingMap: Record<string, Record<string, number>> = {};
      for (const row of spendingRows) {
        if (!row.categoryId) continue;
        if (!spendingMap[row.categoryId]) {
          spendingMap[row.categoryId] = {};
        }
        spendingMap[row.categoryId][row.currency] = Number(row.totalSpent);
      }

      // Build status for each budget
      const statuses = budgetRows.map((budget) => {
        const spending = spendingMap[budget.categoryId] ?? {};
        const budgetAmount = Number(budget.amount);

        const currencies = Object.entries(spending).map(
          ([currency, spent]) => ({
            currency,
            spent: spent.toFixed(4),
            remaining: (budgetAmount - spent).toFixed(4),
            percentUsed: ((spent / budgetAmount) * 100).toFixed(1),
            overBudget: spent > budgetAmount,
          }),
        );

        // If no spending at all, show zero
        if (currencies.length === 0) {
          currencies.push({
            currency: "N/A",
            spent: "0.0000",
            remaining: budgetAmount.toFixed(4),
            percentUsed: "0.0",
            overBudget: false,
          });
        }

        return {
          budgetId: budget.id,
          categoryId: budget.categoryId,
          categoryName: budget.categoryName,
          budgetAmount: budgetAmount.toFixed(4),
          period: budget.period,
          currencies,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                month: `${year}-${String(month).padStart(2, "0")}`,
                budgets: statuses,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- delete_budget ---
  server.tool(
    "delete_budget",
    "Delete a budget by ID (hard delete).",
    {
      id: z.string().uuid().describe("Budget ID to delete"),
    },
    async (params) => {
      const [existing] = await db
        .select({ id: budgets.id })
        .from(budgets)
        .where(eq(budgets.id, params.id))
        .limit(1);

      if (!existing) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Budget ${params.id} not found`,
            },
          ],
        };
      }

      await db.delete(budgets).where(eq(budgets.id, params.id));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: true, id: params.id }, null, 2),
          },
        ],
      };
    },
  );
}
