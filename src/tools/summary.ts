import { z } from "zod";
import { and, gte, lt, lte, eq, sql as dsql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import { transactions, categories } from "../db/schema.js";
import { isValidISODate } from "../lib/dateUtils.js";

export function registerSummaryTools(server: McpServer, db: Database) {
  server.tool(
    "get_summary",
    "Get a financial summary for a date range: expenses grouped by category, totals and averages per currency. Multi-currency aware (no cross-currency conversion).",
    {
      date_from: z
        .string()
        .describe("Start date (ISO 8601, inclusive, required)"),
      date_to: z.string().describe("End date (ISO 8601, inclusive, required)"),
      category_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter by category ID"),
    },
    async (params) => {
      try {
        if (!isValidISODate(params.date_from)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid date_from: must be ISO 8601",
              },
            ],
          };
        }
        if (!isValidISODate(params.date_to)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid date_to: must be ISO 8601",
              },
            ],
          };
        }
        const fromDate = new Date(params.date_from);
        const toDate = new Date(params.date_to);
        // For date-only inputs, normalize to start of next UTC day to include the full day.
        // For datetime inputs, honor the exact timestamp (inclusive).
        const dateCondition = /^\d{4}-\d{2}-\d{2}$/.test(params.date_to)
          ? lt(
              transactions.date,
              new Date(
                Date.UTC(
                  toDate.getUTCFullYear(),
                  toDate.getUTCMonth(),
                  toDate.getUTCDate() + 1,
                ),
              ),
            )
          : lte(transactions.date, toDate);

        const conditions = [gte(transactions.date, fromDate), dateCondition];

        if (params.category_id) {
          conditions.push(eq(transactions.categoryId, params.category_id));
        }

        const whereClause = and(...conditions);

        // Aggregate by category and currency
        const rows = await db
          .select({
            categoryId: transactions.categoryId,
            categoryName: categories.name,
            categoryType: categories.type,
            currency: transactions.currency,
            totalAmount: dsql<string>`sum(${transactions.amount})`,
            txCount: dsql<number>`count(*)::int`,
          })
          .from(transactions)
          .leftJoin(categories, eq(transactions.categoryId, categories.id))
          .where(whereClause)
          .groupBy(
            transactions.categoryId,
            categories.name,
            categories.type,
            transactions.currency,
          );

        // Build category breakdown
        const categoryBreakdown: Array<{
          categoryId: string | null;
          categoryName: string | null;
          categoryType: string | null;
          currency: string;
          total: string;
          count: number;
          average: string;
        }> = rows.map((r) => ({
          categoryId: r.categoryId,
          categoryName: r.categoryName,
          categoryType: r.categoryType,
          currency: r.currency,
          total: Number(r.totalAmount).toFixed(4),
          count: r.txCount,
          average: (Number(r.totalAmount) / r.txCount).toFixed(4),
        }));

        // Compute totals per currency
        const currencyTotals: Record<
          string,
          { income: number; expenses: number; net: number; count: number }
        > = {};

        for (const row of rows) {
          const currency = row.currency;
          if (!currencyTotals[currency]) {
            currencyTotals[currency] = {
              income: 0,
              expenses: 0,
              net: 0,
              count: 0,
            };
          }
          const amount = Number(row.totalAmount);
          currencyTotals[currency].count += row.txCount;
          currencyTotals[currency].net += amount;
          // Classify by sign of stored amount (positive = income, negative = expense)
          // per CLAUDE.md convention, not by category type, to stay consistent with
          // how amounts are stored when a type override is used on add/update_transaction.
          if (amount > 0) {
            currencyTotals[currency].income += amount;
          } else {
            currencyTotals[currency].expenses += amount;
          }
        }

        // Format totals
        const totals = Object.entries(currencyTotals).map(
          ([currency, data]) => ({
            currency,
            income: data.income.toFixed(4),
            expenses: Math.abs(data.expenses).toFixed(4),
            net: data.net.toFixed(4),
            count: data.count,
          }),
        );

        const result = {
          period: {
            from: params.date_from,
            to: params.date_to,
          },
          categoryBreakdown,
          totals,
        };

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
              text: `get_summary failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
