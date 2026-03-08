import {
  pgSchema,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  date,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

const SCHEMA_NAME = process.env.MCP_MONEY_SCHEMA ?? "mcp_money";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(SCHEMA_NAME)) {
  throw new Error(
    `Invalid schema name: "${SCHEMA_NAME}". Must match [a-zA-Z_][a-zA-Z0-9_]*`,
  );
}

export const schema = pgSchema(SCHEMA_NAME);

// --- schema_version ---

export const schemaVersion = schema.table("schema_version", {
  version: numeric("version").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- settings ---

export const settings = schema.table("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// --- categories ---

export const categories = schema.table("categories", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  parentId: uuid("parent_id").references((): any => categories.id),
  type: text("type", { enum: ["expense", "income"] }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- tags ---

export const tags = schema.table("tags", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- transactions ---

export const transactions = schema.table("transactions", {
  id: uuid("id").primaryKey(),
  categoryId: uuid("category_id").references(() => categories.id),
  amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  description: text("description"),
  date: timestamp("date", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata").default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- transaction_tags ---

export const transactionTags = schema.table(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);

// --- budgets ---

export const budgets = schema.table(
  "budgets",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    period: text("period", { enum: ["monthly"] }).notNull(),
    startDate: date("start_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("budgets_category_id_start_date_key").on(t.categoryId, t.startDate),
  ],
);
