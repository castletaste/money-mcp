#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server.js";
import { log } from "./lib/logger.js";

try {
  const { server } = await startServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server connected via stdio transport");
} catch (error) {
  log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
