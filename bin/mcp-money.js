#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "../src/server.js";

try {
  const { server } = await startServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error(
    `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
