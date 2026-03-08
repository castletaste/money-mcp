#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server.js";
import { log } from "./lib/logger.js";

let sql: Awaited<ReturnType<typeof startServer>>["sql"] | undefined;
let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (sql) await sql.end();
  process.exit(0);
};

try {
  const started = await startServer();
  sql = started.sql;
  const { server } = started;

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server disconnected, cleaning up");
  await shutdown();
} catch (error) {
  log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  if (sql) await sql.end();
  process.exit(1);
}
