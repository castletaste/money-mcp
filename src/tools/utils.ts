import { z } from "zod";
import { eq, count, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/connection.js";
import {
  settings,
  schemaVersion,
  transactions,
  categories,
} from "../db/schema.js";

export function registerUtilTools(server: McpServer, db: Database) {
  // --- set_currency ---
  server.tool(
    "set_currency",
    "Set the default currency for new transactions (e.g. USD, EUR, RUB)",
    {
      currency: z
        .string()
        .min(1)
        .describe("Currency code (e.g. USD, EUR, RUB)"),
    },
    async ({ currency }) => {
      try {
        const code = currency.toUpperCase();
        if (!/^[A-Z]{1,10}$/.test(code)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "Invalid currency code: must be 1-10 letters (e.g. USD, EUR, RUB)",
              },
            ],
          };
        }

        await db
          .insert(settings)
          .values({ key: "default_currency", value: code })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: code },
          });

        return {
          content: [
            {
              type: "text" as const,
              text: `Default currency set to ${code}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `set_currency failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  // --- health_check ---
  server.tool(
    "health_check",
    "Check database connection status, schema version, and basic statistics",
    {},
    async () => {
      try {
        // Schema version
        const versionRows = await db
          .select({ version: schemaVersion.version })
          .from(schemaVersion)
          .orderBy(desc(schemaVersion.appliedAt))
          .limit(1);

        // Transaction count
        const txCount = await db.select({ count: count() }).from(transactions);

        // Category count
        const catCount = await db.select({ count: count() }).from(categories);

        // Default currency
        const currencyRow = await db
          .select({ value: settings.value })
          .from(settings)
          .where(eq(settings.key, "default_currency"));

        const result = {
          status: "ok",
          schema_version:
            versionRows.length > 0 ? Number(versionRows[0].version) : null,
          default_currency:
            currencyRow.length > 0 ? currencyRow[0].value : null,
          transaction_count: txCount[0].count,
          category_count: catCount[0].count,
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
              text: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
