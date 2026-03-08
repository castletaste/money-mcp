# mcp-money: Architecture Design Document

## Final Decisions

| Aspect | Decision |
|--------|----------|
| **Positioning** | Expense tracker for AI assistants |
| **MVP scope** | Transactions + categories + tags + summaries + basic budgets (16 tools). No accounts. |
| **Runtime** | Bun-primary, Node-compatible (no Bun-specific APIs in production code) |
| **MCP transport** | stdio only via `@modelcontextprotocol/sdk` |
| **Database** | PostgreSQL only, via Drizzle ORM + postgres.js driver |
| **Schema** | 5 tables: categories, tags, transactions, transaction_tags, budgets. All in `mcp_money` schema. |
| **Migrations** | Auto-migrate on startup with version tracking |
| **Config** | `DATABASE_URL` required. `MCP_MONEY_SCHEMA` optional env var. Currency changed via `set_currency` tool. |
| **Testing** | Integration tests + E2E MCP protocol tests via `bun test` |
| **Observability** | stderr logging + SQL query logging (DEBUG) + health_check tool |
| **Security** | Schema isolation + parameterized queries |
| **Packaging** | npm package, run via `npx mcp-money` |
| **Open-source** | Solo maintainer with reference implementation quality |
| **Launch** | MCP directories → Reddit → HN |
| **Naming** | `mcp-money` |

---

## Schema

```
mcp_money.categories
  id          uuid PK
  name        text NOT NULL UNIQUE
  parent_id   uuid FK -> categories(id)  -- one level of nesting max
  type        text NOT NULL  -- 'expense', 'income'
  created_at  timestamptz

mcp_money.tags
  id          uuid PK
  name        text NOT NULL UNIQUE
  created_at  timestamptz

mcp_money.transactions
  id          uuid PK
  category_id uuid FK -> categories(id) NULLABLE
  amount      numeric(19,4) NOT NULL  -- positive = income, negative = expense
  currency    text NOT NULL DEFAULT 'USD'
  description text
  date        date NOT NULL
  metadata    jsonb DEFAULT '{}'
  created_at  timestamptz
  updated_at  timestamptz

mcp_money.transaction_tags
  transaction_id  uuid FK -> transactions(id) ON DELETE CASCADE
  tag_id          uuid FK -> tags(id) ON DELETE CASCADE
  PRIMARY KEY (transaction_id, tag_id)

mcp_money.budgets
  id          uuid PK
  category_id uuid FK -> categories(id)
  amount      numeric(19,4) NOT NULL
  period      text NOT NULL  -- 'monthly', 'weekly'
  start_date  date NOT NULL
  created_at  timestamptz
```

**Conventions**:
- `numeric(19,4)` for money, never float
- UUID v7 for time-sortable IDs
- `date` not `timestamp` for transaction dates
- Negative amounts = expense, positive = income. MCP tool layer handles `add_expense(amount: 50)` → stores as `-50`.
- Currency column kept on transactions for future multi-currency expansion, no conversion in v1.

---

## MCP Tools (16)

| Tool | Purpose |
|------|---------|
| `add_transaction` | Log expense or income (accepts optional tags) |
| `list_transactions` | Query with filters (date range, category, tag, limit) |
| `update_transaction` | Edit existing transaction (including tags) |
| `delete_transaction` | Remove a transaction |
| `get_summary` | Spending by category for a period, totals, averages |
| `list_categories` | Show available categories |
| `create_category` | Add custom category |
| `delete_category` | Remove a category (fails if transactions reference it) |
| `list_tags` | Show all tags |
| `create_tag` | Add a new tag |
| `delete_tag` | Remove a tag (removes from all transactions) |
| `set_budget` | Set monthly budget for category |
| `get_budget_status` | Check budget vs actual spending |
| `delete_budget` | Remove a budget |
| `set_currency` | Change default currency for new transactions |
| `health_check` | Report DB status, version, stats |

**Destructive tool behavior**:
- `delete_transaction` — hard delete
- `delete_category` — RESTRICT: fails if any transactions reference it
- `delete_tag` — CASCADE: removes tag and all transaction_tags associations, transactions untouched
- `delete_budget` — hard delete

---

## Business Logic

**Categories**: ~10 seed defaults (Groceries, Restaurants, Transport, Entertainment, Utilities, Rent, Salary, Healthcare, Shopping, Other). Users add custom ones via `create_category`. One level of nesting max (parent_id), not enforced in v1.

**Tags**: Flexible cross-cutting labels. Many-to-many via junction table. Created on-the-fly in `add_transaction` or via `create_tag`. No presets — purely user-defined.

**Budgets**: Monthly per category only. Covers 90% of use cases.

**Currency**: Changed via `set_currency` MCP tool. Default: `USD`. Stored in `mcp_money.settings` key-value row. Currency per transaction, no conversion — summaries group by currency.

**Migrations**: Auto-migrate on startup. Version table `mcp_money.schema_version`. Apply in transaction, rollback on error. Destructive migrations require `--force` flag.

---

## Config

```json
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["mcp-money"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb"
      }
    }
  }
}
```

- `DATABASE_URL` — required
- `MCP_MONEY_SCHEMA` — optional (default `mcp_money`)
- `DEBUG=true` — enables SQL query logging to stderr

---

## Implementation Plan

### Phase 0: Repo Bootstrap (Day 1)

- Initialize package.json with name, version, description, bin, exports
- Dependencies: `@modelcontextprotocol/sdk`, `drizzle-orm`, `postgres`
- Dev deps: `drizzle-kit`, `@types/bun`, `typescript`
- tsconfig.json for Bun + Node compatibility
- `.github/workflows/ci.yml` (lint + test)
- docker-compose.yml with Postgres
- .gitignore, LICENSE (MIT)

### Phase 1: Database Layer (Day 2-3)

- Drizzle schema in `src/db/schema.ts` (5 tables)
- Auto-migration system with version tracking
- DB connection via `DATABASE_URL`
- Seed ~10 default categories
- Integration tests for schema creation and seeding

### Phase 2: MCP Server Skeleton (Day 3-4)

- MCP server with `@modelcontextprotocol/sdk` + `StdioServerTransport`
- Register tool definitions with JSON schemas
- health_check tool
- DB connection lifecycle (connect on start, close on exit)

### Phase 3: Core Tools (Day 4-7)

All 16 tools:
- `add_transaction`, `list_transactions`, `update_transaction`, `delete_transaction`
- `get_summary`
- `list_categories`, `create_category`, `delete_category`
- `list_tags`, `create_tag`, `delete_tag`
- `set_budget`, `get_budget_status`, `delete_budget`
- `set_currency`, `health_check`
- Integration tests + E2E MCP protocol tests

### Phase 4: Polish and Release (Day 8-10)

- npm package config (bin entry, exports)
- Build step for Node.js compatibility
- README: pitch, install, config, usage examples, demo GIF
- CHANGELOG.md, CONTRIBUTING.md
- Test on Claude Desktop, Claude Code, Cursor
- Publish to npm, submit to awesome-mcp-servers

### Phase 5: Post-MVP (Month 2+)

Driven by user feedback:
- Accounts support (optional FK on transactions)
- Recurring transactions
- CSV import/export
- Spending trends
- Multi-currency with conversion
- SQLite support via Drizzle

---

## Repository Structure

```
mcp-money/
├── src/
│   ├── index.ts              # entry point: parse config, connect DB, start MCP server
│   ├── config.ts             # env var parsing and validation
│   ├── db/
│   │   ├── connection.ts     # postgres.js connection
│   │   ├── schema.ts         # Drizzle table definitions (5 tables)
│   │   ├── migrate.ts        # auto-migration runner
│   │   ├── seed.ts           # default categories (~10)
│   │   └── migrations/       # numbered SQL files
│   │       ├── 001_initial.sql
│   │       └── ...
│   └── tools/
│       ├── index.ts          # tool registry
│       ├── transactions.ts   # add, list, update, delete
│       ├── categories.ts     # list, create, delete
│       ├── tags.ts           # list, create, delete
│       ├── budgets.ts        # set, get_status, delete
│       ├── summary.ts        # get_summary
│       ├── settings.ts       # set_currency
│       └── health.ts         # health_check
├── tests/
│   ├── setup.ts              # test DB setup/teardown
│   ├── transactions.test.ts
│   ├── budgets.test.ts
│   ├── summary.test.ts
│   └── e2e/
│       └── mcp-protocol.test.ts
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── docker-compose.yml
├── LICENSE
├── README.md
├── CHANGELOG.md
└── CLAUDE.md
```

---

## Task Breakdown

### First 10 tasks

1. Set up package.json with proper fields (name, version, bin, exports, dependencies)
2. Configure tsconfig.json for ESM + both runtimes
3. Create docker-compose.yml with PostgreSQL 16
4. Implement `src/config.ts` — parse DATABASE_URL and optional env vars
5. Define Drizzle schema in `src/db/schema.ts` — 5 tables
6. Implement `src/db/connection.ts` — postgres.js connection pool
7. Implement `src/db/migrate.ts` — auto-migration with version tracking
8. Write `src/db/migrations/001_initial.sql` — create schema and tables
9. Implement `src/db/seed.ts` — ~10 default categories
10. Write first integration test: schema creation + seeding

### Next 11 tasks

11. Implement MCP server skeleton in `src/index.ts`
12. Implement `health_check` tool
13. Implement `add_transaction` tool
14. Implement `list_transactions` tool with filters
15. Implement `update_transaction` and `delete_transaction` tools
16. Implement `list_categories`, `create_category`, and `delete_category` tools
17. Implement `list_tags`, `create_tag`, and `delete_tag` tools
18. Implement `get_summary` tool (spending by category/period)
19. Implement `set_budget`, `get_budget_status`, and `delete_budget` tools
20. Implement `set_currency` tool
21. Write integration tests + E2E MCP protocol tests for all tools

### Post-MVP tasks

22. Write README with usage examples and demo GIF
23. Set up GitHub Actions CI (lint + test with Postgres service)
24. Configure npm publishing (bin entry, shebang, build step)
25. Test on Claude Desktop, Claude Code, Cursor
26. Publish v0.1.0 to npm
27. Submit to awesome-mcp-servers
28. Add accounts support (optional FK on transactions)
29. Add recurring transactions
30. Add CSV export tool
31. Add spending trends tool
32. Add multi-currency conversion with external rates API
33. Add SQLite support via Drizzle dialect

---

## Decision Log

### Chose

| Decision | Rationale |
|----------|-----------|
| PostgreSQL only | SQL-first requirement, no local files, Drizzle makes it type-safe |
| Drizzle ORM | Type-safe, multi-dialect ready for future, lightweight |
| postgres.js driver | Works on both Bun and Node, no native bindings |
| stdio-only MCP | 95% of MCP usage is stdio, HTTP is premature |
| Auto-migration on startup | Zero friction for users, critical for adoption |
| No accounts in MVP | Simplifies schema and tools. Can add later as optional FK. |
| Tags in MVP | Lightweight many-to-many. Flexible labeling beyond rigid categories. |
| 16 tools total | CRUD for all entities + summary + budget status + set_currency + health_check |
| Negative amounts for expenses | Simpler math, LLM handles presentation |
| UUID v7 for IDs | Time-sortable, no sequence conflicts |
| `mcp_money` schema | Isolation without requiring dedicated database |
| npm package distribution | Standard MCP installation pattern |
| Monthly-only budgets | 90% use case, simple implementation |
| ~10 seeded default categories | Better UX than empty start, but not overwhelming |
| `numeric(19,4)` for money | Never float. Industry standard precision. |
| Currency via MCP tool | More natural than env var — LLM says "switch to EUR" |
| Integration + E2E MCP tests | Full coverage: tool logic + protocol compliance |
| Currency column on transactions | Kept for future multi-currency expansion |

### Consciously rejected

| Decision | Reason |
|----------|--------|
| SQLite as primary store | User requirement: no local files |
| Accounts table in MVP | Adds complexity without proportional value for v1 |
| Multi-DB support in v1 | Complexity explosion for unproven demand |
| Double-entry bookkeeping | Scares users, solves wrong problem for personal tracking |
| Config file | 2 settings don't justify a config file |
| Docker for MCP server | stdio over Docker is awkward |
| Rate limiting | Absurd for personal finance tool |
| MCP confirmation for deletes | MCP has no native confirmation mechanism |
| Structured logging (pino) | Over-engineered for v1 |
| Event sourcing | 10x complexity for near-zero benefit in personal finance |
| Plugin system | Premature abstraction |
| Currency as env var | Tool-based approach is more natural for LLM interaction |

### Deferred to post-MVP

| Feature | When | Trigger |
|---------|------|---------|
| Accounts | v1.1 | User demand for separating cash/bank/card |
| Recurring transactions | v1.1 | User demand |
| Multi-currency conversion | v1.2 | User demand + good rate API found |
| CSV import/export | v1.1 | Obvious early request |
| Spending trends | v1.2 | After summaries prove useful |
| SQLite support | v2.0 | If Postgres is blocking adoption |
| HTTP/SSE transport | v2.0 | When MCP clients support it widely |
| Web dashboard | Never (probably) | Out of scope for MCP server |

### Re-evaluate after MVP

| Decision | Re-evaluate when |
|----------|-----------------|
| PostgreSQL-only | If >30% of issues are "how do I set up Postgres" |
| No accounts | If >5 users request separating transactions by source |
| Amount sign convention | If users/LLMs are confused by negative amounts |
| Auto-migration | If any user reports data loss |
| Drizzle ORM | If it causes runtime issues on Node |
| Tool count | If LLMs struggle with tools (reduce) or users ask for more (expand) |
| Monthly-only budgets | If >5 requests for weekly/quarterly |
| UUID v7 | If any driver compatibility issues |
