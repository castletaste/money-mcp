import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schemaExports from "./schema.js";

export function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL environment variable is required. Example: postgresql://user:pass@localhost:5432/mydb",
    );
  }
  return url;
}

export function createConnection() {
  const connectionString = getConnectionString();
  const sql = postgres(connectionString);
  const db = drizzle(sql, { schema: schemaExports });
  return { db, sql };
}

export type Database = ReturnType<typeof createConnection>["db"];
