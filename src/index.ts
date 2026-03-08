#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server.js";
import { log } from "./lib/logger.js";

try {
  const { server, sql } = await startServer();

  const shutdown = async () => {
    await sql.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server disconnected, cleaning up");
  await sql.end();
} catch (error) {
  log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
