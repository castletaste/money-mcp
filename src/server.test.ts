import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import postgres from "postgres";
import { createMcpServer } from "./server.js";
import { migrate } from "./db/migrate.js";
import { seed } from "./db/seed.js";

const TEST_SCHEMA = process.env.MCP_MONEY_SCHEMA!;
let sql: postgres.Sql;

beforeAll(async () => {
  sql = postgres(process.env.DATABASE_URL!);
  await migrate(sql);
  await seed(sql);
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await sql.end();
});

describe("MCP server", () => {
  test("creates server instance", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  test("connects via InMemoryTransport and lists registered tools", async () => {
    const server = createMcpServer();

    server.tool(
      "test_tool",
      "A test tool",
      { name: z.string() },
      async ({ name }) => ({
        content: [{ type: "text", text: `Hello ${name}` }],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toBeArray();
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].name).toBe("test_tool");
    expect(result.tools[0].description).toBe("A test tool");

    await client.close();
    await server.close();
  });

  test("server info returns correct name and version", async () => {
    const server = createMcpServer();

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const info = client.getServerVersion();
    expect(info?.name).toBe("mcp-money");
    expect(info?.version).toBe("0.1.0");

    await client.close();
    await server.close();
  });
});
