import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createConnection, type Database } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerSummaryTools } from "./tools/summary.js";
import { log, debug } from "./lib/logger.js";
import type postgres from "postgres";

// Read version from package.json
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();

export interface ServerContext {
  server: McpServer;
  db: Database;
  sql: postgres.Sql;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mcp-money",
    version: pkg.version,
  });

  return server;
}

export async function startServer(): Promise<ServerContext> {
  log("Starting mcp-money server...");

  // Connect to database
  debug("Connecting to database...");
  const { db, sql } = createConnection();

  // Run auto-migration
  debug("Running auto-migration...");
  await migrate(sql);
  log("Database migration complete");

  // Seed default categories
  debug("Seeding default categories...");
  await seed(sql);
  log("Default categories seeded");

  // Create MCP server
  const server = createMcpServer();

  // Register tools
  registerCategoryTools(server, db);
  registerTagTools(server, db);
  registerTransactionTools(server, db);
  registerSummaryTools(server, db);

  log(`mcp-money server v${pkg.version} ready`);

  return { server, db, sql };
}
