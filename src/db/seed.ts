import { v7 as uuidv7 } from "uuid";
import type postgres from "postgres";

interface DefaultCategory {
  name: string;
  type: "expense" | "income";
}

const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: "Groceries", type: "expense" },
  { name: "Restaurants", type: "expense" },
  { name: "Transport", type: "expense" },
  { name: "Entertainment", type: "expense" },
  { name: "Utilities", type: "expense" },
  { name: "Rent", type: "expense" },
  { name: "Salary", type: "income" },
  { name: "Healthcare", type: "expense" },
  { name: "Shopping", type: "expense" },
  { name: "Other", type: "expense" },
];

function getSchemaName(): string {
  return process.env.MCP_MONEY_SCHEMA ?? "mcp_money";
}

export async function seed(sql: postgres.Sql): Promise<void> {
  const schemaName = getSchemaName();

  for (const cat of DEFAULT_CATEGORIES) {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".categories (id, name, type) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [uuidv7(), cat.name, cat.type],
    );
  }
}

export { DEFAULT_CATEGORIES };
