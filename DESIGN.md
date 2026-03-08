# mcp-money: Architecture Design Document

## 1. Positioning

| Variant | Description | Clarity | Usefulness | Adoption | Stars | Long-term |
|---------|------------|---------|-----------|----------|-------|-----------|
| **A. "Personal finance MCP server"** | Generic personal finance tracker via MCP | 7/10 | 7/10 | 6/10 | 5/10 | 5/10 |
| **B. "Expense tracker for AI assistants"** | Focused on expense/income logging via LLM | 9/10 | 8/10 | 8/10 | 7/10 | 7/10 |
| **C. "AI-native ledger"** | Double-entry bookkeeping via MCP, like hledger but AI-first | 6/10 | 6/10 | 4/10 | 6/10 | 8/10 |
| **D. "MCP money memory"** | LLM remembers your spending; conversational finance | 8/10 | 7/10 | 7/10 | 8/10 | 5/10 |

**Tradeoff**: "AI-native ledger" (C) is technically strongest but scares away 80% of users. "MCP money memory" (D) is catchy but gimmicky — risks becoming a toy.

### Recommendation

- **MVP**: **B — "Expense tracker for AI assistants"**. Clear value prop, easy to explain, easy to demo. "Tell Claude what you spent, it remembers and tracks it in PostgreSQL."
- **Backup**: D — can evolve messaging toward "memory" framing later.
- **Defer**: C — double-entry is a v2+ feature if demand exists. Don't build hledger.

---

## 2. MVP Scope

| Variant | Includes | Excludes | Too weak if... | Too heavy if... |
|---------|----------|----------|----------------|-----------------|
| **A. Minimal** | add/list/delete transactions, single currency, flat categories | budgets, recurring, multi-currency, reports, tags | no summaries at all | — |
| **B. Practical** | A + summaries (by period/category), basic budgets, account support | recurring, multi-currency, tags, import/export | — | — |
| **C. Feature-rich** | B + recurring transactions, tags, multi-currency, CSV import | advanced reports, forecasting, goals | — | multi-currency in MVP is a trap |
| **D. Full** | C + audit history, templates, rules, bank integrations | nothing | — | definitely overbuilt for v1 |

**Critical take**: Multi-currency, recurring transactions, and import/export are the three features that feel "obvious" but each adds 2-3 weeks of work and edge cases. They kill MVPs.

### Recommendation

- **MVP**: **B — Practical**. Transactions + categories + accounts + summaries + basic budgets. This is the minimum to be *useful*, not just a demo.
- **Backup**: A — if time is tight, ship without budgets. Summaries are non-negotiable.
- **Defer**: Multi-currency (see section 10), recurring, tags, import/export.

---

## 3. Runtime and Platform

| Variant | Description | Compat | DX | Publishing | Maintenance | Contributor onboarding |
|---------|------------|--------|-----|------------|-------------|----------------------|
| **A. Bun-only** | Target Bun exclusively | 4/10 | 9/10 | 7/10 | 9/10 | 6/10 |
| **B. Node-only** | Target Node.js with tsx/ts-node | 9/10 | 6/10 | 9/10 | 7/10 | 9/10 |
| **C. Bun-primary, Node-compatible** | Write for Bun, test on Node, avoid Bun-specific APIs | 8/10 | 8/10 | 8/10 | 7/10 | 8/10 |
| **D. Runtime-agnostic via std libs** | Only use node: APIs that both runtimes support | 9/10 | 5/10 | 8/10 | 6/10 | 8/10 |

**Critical take**: Your CLAUDE.md says "default to Bun" but you also said "compatible with Bun and Node.js". These conflict if you use `Bun.serve()`, `Bun.file()`, `bun:sqlite`, etc. For an MCP server (stdio-based), you don't need `Bun.serve()`. The main risk is the DB driver — `bun:sqlite` is Bun-only, but since we're going PostgreSQL, this isn't an issue.

**Key insight**: MCP servers run over stdio. There's no HTTP server needed. The runtime-specific surface is actually very small: it's just "can you run TypeScript and connect to Postgres?"

### Recommendation

- **MVP**: **C — Bun-primary, Node-compatible**. Develop with Bun, use `bun test`, but stick to `node:` compatible APIs and a universal Postgres driver. The MCP SDK itself is runtime-agnostic.
- **Backup**: B — if adoption is priority over DX.
- **Defer**: A — locking to Bun kills half the potential userbase today.

**Practical rule**: No `Bun.*` APIs in production code. `bun test` and `bun run` for dev are fine.

---

## 4. MCP Implementation Model

| Variant | Description | Simplicity | Flexibility | Scale | Local use | Remote use |
|---------|------------|-----------|-------------|-------|-----------|------------|
| **A. stdio only** | Classic MCP server via stdin/stdout using `@modelcontextprotocol/sdk` | 9/10 | 6/10 | 5/10 | 9/10 | 3/10 |
| **B. stdio + SSE** | stdio for local, Server-Sent Events for remote | 7/10 | 8/10 | 7/10 | 9/10 | 8/10 |
| **C. Streamable HTTP only** | MCP over HTTP (new spec) | 6/10 | 7/10 | 8/10 | 6/10 | 9/10 |
| **D. stdio with optional HTTP wrapper** | stdio by default, separate `--http` flag adds HTTP transport | 8/10 | 9/10 | 7/10 | 9/10 | 7/10 |

**Critical take**: 95% of current MCP usage is stdio via Claude Desktop / Claude Code / Cursor. SSE and Streamable HTTP are emerging but the ecosystem isn't there yet. Building HTTP transport in MVP is wasted effort.

### Recommendation

- **MVP**: **A — stdio only**. Use `@modelcontextprotocol/sdk` with `StdioServerTransport`. This is what every MCP client expects today.
- **Backup**: D — add HTTP transport as a separate entry point later.
- **Defer**: B, C — wait until MCP clients actually support these transports widely.

---

## 5. Database Strategy

| Variant | Description | Complexity | Portability | Stability | User DX | Author DX |
|---------|------------|-----------|-------------|-----------|---------|-----------|
| **A. PostgreSQL only** | Single target, full Postgres features | 3/10 | 4/10 | 9/10 | 7/10 | 9/10 |
| **B. PostgreSQL + SQLite** | Postgres for prod, SQLite for local/quick start | 6/10 | 7/10 | 7/10 | 9/10 | 5/10 |
| **C. Any SQL via Kysely/Drizzle** | ORM/query builder abstracting multiple DBs | 7/10 | 9/10 | 6/10 | 8/10 | 4/10 |
| **D. PostgreSQL via raw SQL** | Raw queries, no ORM, pg driver only | 4/10 | 4/10 | 9/10 | 7/10 | 7/10 |

**Critical take**: You said "no local SQLite as primary" — good. But requiring PostgreSQL is a real adoption barrier. Every user needs a running Postgres instance. This is the #1 friction point for the entire project.

**The elephant in the room**: Free hosted Postgres options (Neon, Supabase, etc.) exist, but requiring users to set up external infra for a personal expense tracker is friction. The counterargument: anyone using MCP servers is already technical enough to have Postgres.

**Tradeoff**: PostgreSQL-only = simpler code but harder onboarding. Multi-DB = harder code but easier onboarding.

### Recommendation

- **MVP**: **A — PostgreSQL only, via Drizzle ORM for type safety**. Use Drizzle with `drizzle-orm/pg-core` + `postgres` (postgres.js driver — works on both Bun and Node). Don't use raw SQL; Drizzle gives you typed queries, migrations, and schema-as-code.
- **Backup**: D — raw SQL with `postgres` driver if you want zero ORM deps.
- **Defer**: B — SQLite support can be added later via Drizzle's multi-dialect support if demand exists.
- **Mitigation for onboarding**: Provide docker-compose.yml with Postgres for quick start. Document Neon free tier as 1-click cloud option.

---

## 6. Schema Design

### Core entities analysis

| Entity | MVP? | Complexity | Value |
|--------|------|-----------|-------|
| **transactions** | Yes | Low | Critical |
| **accounts** | Yes | Low | High — separates cash/bank/card |
| **categories** | Yes | Low-Med | High |
| **budgets** | Yes (basic) | Medium | High |
| **recurring_transactions** | No | High | Medium |
| **tags** | No | Low | Low-Medium |
| **currencies** | No | High | Medium |
| **audit/edit history** | No | Medium | Low for v1 |

### Schema variants

| Variant | Description | Simplicity | Extensibility | Query perf |
|---------|------------|-----------|---------------|------------|
| **A. Flat** | transactions + categories (inline). No accounts table. | 9/10 | 3/10 | 8/10 |
| **B. Normalized** | transactions, accounts, categories as separate tables with FKs | 7/10 | 8/10 | 8/10 |
| **C. Normalized + JSONB** | B + JSONB `metadata` column on transactions for extensibility | 6/10 | 9/10 | 7/10 |
| **D. Event-sourced** | Append-only events, materialized views for balances | 3/10 | 10/10 | 5/10 |

### Recommended MVP schema (Variant B+C hybrid)

```
mcp_money.accounts
  id          uuid PK
  name        text NOT NULL
  type        text NOT NULL  -- 'checking', 'savings', 'cash', 'credit_card'
  currency    text NOT NULL DEFAULT 'USD'
  created_at  timestamptz
  updated_at  timestamptz

mcp_money.categories
  id          uuid PK
  name        text NOT NULL UNIQUE
  parent_id   uuid FK -> categories(id)  -- one level of nesting max
  type        text NOT NULL  -- 'expense', 'income'
  created_at  timestamptz

mcp_money.transactions
  id          uuid PK
  account_id  uuid FK -> accounts(id)
  category_id uuid FK -> categories(id) NULLABLE
  amount      numeric(19,4) NOT NULL  -- positive = income, negative = expense
  currency    text NOT NULL DEFAULT 'USD'
  description text
  date        date NOT NULL
  metadata    jsonb DEFAULT '{}'
  created_at  timestamptz
  updated_at  timestamptz

mcp_money.budgets
  id          uuid PK
  category_id uuid FK -> categories(id)
  amount      numeric(19,4) NOT NULL
  period      text NOT NULL  -- 'monthly', 'weekly'
  start_date  date NOT NULL
  created_at  timestamptz
```

### Recommendation

- **MVP**: Variant B with a `metadata jsonb` column on transactions for future flexibility. 4 tables: accounts, categories, transactions, budgets.
- **Defer**: tags (use metadata jsonb for now), recurring_transactions, audit history, multi-currency conversion.
- **Critical**: Use `numeric(19,4)` for money, never float. Use UUID v7 for time-sortable IDs. Use `date` not `timestamp` for transaction dates (you don't need sub-day precision for "I bought coffee").
- **Convention**: Negative amounts = expense, positive = income. This is simpler than separate `type` + positive amount.

**Why no sign convention debate?** Because the MCP tool layer will handle `add_expense(amount: 50)` → stores as `-50`. Users never see the sign. The LLM handles presentation.

---

## 7. Migrations

| Variant | Description | Reliability | Simplicity | OSS UX | Auto-migrate risk |
|---------|------------|-------------|-----------|--------|-------------------|
| **A. Drizzle Kit migrations** | `drizzle-kit generate` + `drizzle-kit migrate` | 8/10 | 8/10 | 8/10 | Low |
| **B. Auto-migrate on startup** | Server checks schema version, applies SQL files on boot | 7/10 | 9/10 | 9/10 | Medium |
| **C. Manual SQL files** | Numbered .sql files, user runs them manually | 9/10 | 4/10 | 4/10 | None |
| **D. Drizzle push (dev) + migrations (prod)** | `drizzle-kit push` for dev, generated migrations for releases | 7/10 | 7/10 | 7/10 | Low |

**Critical take**: For a standalone MCP server, the user should NOT have to run migrations manually. That kills adoption. But auto-migration on production databases is scary. The sweet spot: auto-migrate with a version table and confirmation.

### Recommendation

- **MVP**: **B — Auto-migrate on startup** with safety rails. On first connection, create `mcp_money.schema_version` table. On subsequent starts, check version and apply pending migrations. Use Drizzle for schema definition but ship migration SQL files that run sequentially.
- **Safety**: Log what will be applied, apply in a transaction, rollback on error. For destructive migrations (column drops), require `--force` flag.
- **Backup**: A — Drizzle Kit if you want more control.
- **Defer**: C — manual migrations only make sense for enterprise users.

---

## 8. MCP Tools

### Variant A: Minimal (6 tools)

| Tool | Purpose | MVP? |
|------|---------|------|
| `add_transaction` | Log expense or income | Yes |
| `list_transactions` | Query with filters (date range, category, account) | Yes |
| `delete_transaction` | Remove a transaction | Yes |
| `get_summary` | Spending summary by period/category | Yes |
| `list_categories` | Show available categories | Yes |
| `list_accounts` | Show accounts | Yes |

### Variant B: Practical (11 tools)

All of A, plus:

| Tool | Purpose | MVP? |
|------|---------|------|
| `update_transaction` | Edit existing transaction | Yes |
| `create_category` | Add custom category | Yes |
| `create_account` | Add new account | Yes |
| `set_budget` | Set monthly budget for category | Yes |
| `get_budget_status` | Check budget vs actual spending | Yes |

### Variant C: Feature-rich (17 tools)

All of B, plus:

| Tool | Purpose | MVP? |
|------|---------|------|
| `add_recurring` | Set up recurring transaction | No |
| `list_recurring` | Show recurring transactions | No |
| `get_trends` | Spending trends over time | No |
| `search_transactions` | Full-text search in descriptions | No |
| `export_csv` | Export data | No |
| `import_csv` | Import data | No |

### Variant D: Kitchen sink (25+ tools)

All of C, plus transfer_between_accounts, set_goal, get_forecast, add_tag, merge_categories, undo_last, get_net_worth, etc.

**Critical take**: Every tool you add is a tool the LLM has to understand and choose from. More tools = more token usage per call = slower responses = worse UX. Keep the tool list tight.

### Recommendation

- **MVP**: **Variant B — 11 tools**. This is the minimum to be a useful daily tracker, not a toy demo.
- **Key insight**: `get_summary` is the most important tool after `add_transaction`. Without summaries, the server is just a dumb INSERT machine. The LLM should be able to say "You spent $450 on food this month, 20% over budget."
- **Defer**: Recurring, trends, import/export, search. All are v1.1+.
- **Cut aggressively**: Don't build `undo_last`. The LLM can call `delete_transaction` or `update_transaction`.

---

## 9. Business Logic

### Categories

| Approach | Description | Simplicity | Flexibility |
|----------|------------|-----------|-------------|
| **A. User-defined only** | Empty on start, user creates all categories | 7/10 | 10/10 |
| **B. Seed defaults + user-defined** | Ship 15-20 common categories, user can add more | 9/10 | 9/10 |
| **C. Hierarchical categories** | Parent/child (Food > Restaurants, Groceries) | 5/10 | 8/10 |

**Recommendation**: **B for MVP** — seed defaults (Groceries, Restaurants, Transport, Entertainment, Utilities, Rent, Salary, etc.). Allow users to add custom ones. One level of nesting max (parent_id), but don't enforce hierarchy in v1 — just support it in schema.

### Budgets

| Approach | Description | Simplicity | Value |
|----------|------------|-----------|-------|
| **A. Monthly per category** | Simple: "Food budget is $500/month" | 9/10 | 8/10 |
| **B. Flexible period** | Weekly/monthly/quarterly budgets | 6/10 | 7/10 |
| **C. Rollover budgets** | Unused budget carries over | 4/10 | 6/10 |

**Recommendation**: **A — monthly per category only**. This covers 90% of use cases. Weekly/quarterly is v2.

### Recurring transactions

**Recommendation**: **Not in MVP.** Recurring transactions need a scheduler or a "materialize on query" pattern. Both add complexity. Users can just tell the LLM "add my $50 gym membership" each month. Defer to v1.1.

### Rules and templates

**Recommendation**: **Not in MVP.** Premature. The LLM IS the rule engine — it can apply patterns conversationally. Don't duplicate what the LLM does naturally.

---

## 10. Multi-currency

| Variant | Description | Complexity | Value | Error risk |
|---------|------------|-----------|-------|------------|
| **A. Single currency, user-configured** | One currency globally, set in config | 1/10 | 6/10 | 1/10 |
| **B. Currency per transaction** | Store currency on each tx, no conversion | 3/10 | 7/10 | 2/10 |
| **C. Currency per account + conversion** | Each account has a currency, convert for summaries | 7/10 | 8/10 | 7/10 |
| **D. Full multi-currency with rate history** | Store exchange rates, convert at historical rates | 9/10 | 9/10 | 9/10 |

**Critical take**: Multi-currency is the #1 complexity trap in finance apps. Exchange rates, rounding errors, which rate to use (transaction date? today?), API dependencies for rates — it spirals fast.

### Recommendation

- **MVP**: **B — Currency per transaction, no conversion**. Store the currency code (ISO 4217) on each transaction. Default from account currency. Summaries group by currency — don't convert. This is honest and simple.
- **Defer**: C, D. Conversion requires an exchange rate source, caching, and rounding policy. All are v2.
- **Schema preparation**: The `currency` column is already in the schema (section 6). You're ready to extend without migration pain.

---

## 11. Packaging and Installation

| Variant | Description | First-run simplicity | Updates | DX | Adoption |
|---------|------------|---------------------|---------|-----|----------|
| **A. npm package** | `npx mcp-money` or `bunx mcp-money` | 9/10 | 9/10 | 8/10 | 9/10 |
| **B. Docker image** | `docker run mcp-money` | 7/10 | 8/10 | 6/10 | 7/10 |
| **C. Git clone + run** | Clone repo, `bun install && bun start` | 5/10 | 4/10 | 7/10 | 5/10 |
| **D. npm + Docker** | npm for MCP stdio, Docker for self-hosted with DB included | 8/10 | 8/10 | 7/10 | 8/10 |

**Critical take**: MCP servers are typically configured in `claude_desktop_config.json` as a command. The dominant pattern is `npx @org/mcp-server`. Docker doesn't work well with stdio-based MCP.

### Recommendation

- **MVP**: **A — npm package**. Publish as `mcp-money` on npm. Usage: `npx mcp-money` with `DATABASE_URL` env var. This is the standard MCP installation pattern.
- **Also ship**: `docker-compose.yml` with Postgres for users who need a quick DB. But the MCP server itself runs via npx, not Docker.
- **Defer**: Docker image of the server itself. Stdio over Docker is awkward.
- **Config example for Claude Desktop**:
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

---

## 12. Config Model

| Variant | Description | Simplicity | Extensibility | Error rate | Zero-friction |
|---------|------------|-----------|---------------|------------|--------------|
| **A. Env vars only** | `DATABASE_URL` and nothing else | 10/10 | 3/10 | 2/10 | 10/10 |
| **B. Env vars + config file** | .env for connection, JSON/YAML for preferences | 6/10 | 8/10 | 5/10 | 6/10 |
| **C. Env vars + CLI flags** | `--currency USD --schema mcp_money` | 7/10 | 6/10 | 3/10 | 8/10 |
| **D. All in DATABASE_URL + query params** | `postgres://...?schema=mcp_money&currency=USD` | 8/10 | 4/10 | 4/10 | 9/10 |

**Critical take**: For MVP, what configuration does the user actually need?
1. `DATABASE_URL` — required
2. Default currency — optional (default USD)
3. Schema name — optional (default mcp_money)

That's it. You don't need a config file for 3 settings.

### Recommendation

- **MVP**: **A+C hybrid — env vars + a few CLI flags**. `DATABASE_URL` is the only required config. Optional: `MCP_MONEY_CURRENCY=EUR`, `MCP_MONEY_SCHEMA=mcp_money`. That's it.
- **Defer**: Config files. You don't need them until you have 10+ settings.
- **Rule**: If you can't justify a config option with a real user scenario, don't add it.

---

## 13. Testing Strategy

| Variant | Description | Min coverage | Quality impact | Regression safety | Effort |
|---------|------------|-------------|----------------|-------------------|--------|
| **A. Unit tests only** | Test business logic functions in isolation | Low | Medium | Low | Low |
| **B. Integration tests with test DB** | Spin up Postgres, test full tool → DB flow | High | High | High | Medium |
| **C. B + E2E MCP tests** | Test full MCP protocol round-trips | Very high | Very high | Very high | High |
| **D. B + snapshot tests** | Integration tests + snapshot tool outputs | High | High | High | Medium |

**Critical take**: For an MCP server, the most valuable tests are integration tests that verify: tool call → SQL → correct response. Unit testing individual SQL queries without a DB is low-value.

### Recommendation

- **MVP**: **B — Integration tests with a test Postgres**. Use `bun test` with a test database. Each test suite creates a fresh schema, runs tools, asserts results.
- **Require**: docker-compose for test Postgres (or use existing local Postgres).
- **Key tests**: add_transaction → list_transactions round-trip, get_summary correctness, budget status calculations.
- **Defer**: E2E MCP protocol tests (the SDK handles transport), snapshot tests.

---

## 14. Observability and Debugging

| Variant | Description | V1 critical? | Value later | Implementation cost |
|---------|------------|-------------|------------|-------------------|
| **A. stderr logging** | console.error for logs (MCP best practice — stdout is protocol) | Yes | Yes | 1/10 |
| **B. Structured logging** | JSON logs with levels via pino/winston | Maybe | Yes | 3/10 |
| **C. SQL query logging** | Log all queries in debug mode | Yes | Yes | 2/10 |
| **D. Health check tool** | MCP tool `health_check` that reports DB status, version, stats | Yes | Yes | 2/10 |

### Recommendation

- **MVP**: **A + C + D**. stderr logging (required for MCP — stdout is the protocol channel), SQL query logging behind `DEBUG=true`, and a `health_check` tool. Simple, effective.
- **Defer**: Structured logging with pino. Over-engineered for v1.
- **Critical rule**: NEVER write to stdout except MCP protocol messages. All logs go to stderr.

---

## 15. Safety and Security

| Variant | Description | Realism | Cost | UX impact |
|---------|------------|---------|------|-----------|
| **A. Trust the LLM** | No confirmation, no limits | 10/10 | 0/10 | 10/10 |
| **B. Schema isolation** | All tables in `mcp_money` schema, restricted DB user recommended | 9/10 | 2/10 | 9/10 |
| **C. Rate limiting** | Max N transactions per minute | 5/10 | 4/10 | 7/10 |
| **D. Confirmation for destructive ops** | Delete requires re-confirmation via MCP | 3/10 | 5/10 | 5/10 |

**Critical take**: MCP servers don't have a built-in confirmation mechanism. The LLM decides when to call tools. Rate limiting on a personal finance tool is absurd. The real security boundary is: use a dedicated Postgres user with only `mcp_money` schema access.

### Recommendation

- **MVP**: **B — Schema isolation**. Use `mcp_money` schema. Document "create a dedicated Postgres user with access only to this schema." That's it.
- **Also**: SQL injection is impossible if you use parameterized queries (Drizzle handles this).
- **Defer**: C, D. Not realistic for MCP's interaction model.
- **Document**: "This server will CREATE, READ, UPDATE, DELETE data in the `mcp_money` schema. Use a dedicated database or user."

---

## 16. Open-source Strategy

| Variant | Description | Stars potential | Contributors | Maintenance | Sustainability |
|---------|------------|----------------|-------------|-------------|---------------|
| **A. Solo maintainer** | You maintain, accept PRs occasionally | 5/10 | 3/10 | 9/10 | 6/10 |
| **B. Community-driven** | Active issues, discussions, contributor guide | 7/10 | 7/10 | 5/10 | 7/10 |
| **C. Company-backed** | Part of a larger MCP ecosystem | 8/10 | 5/10 | 4/10 | 5/10 |
| **D. "Batteries included" showcase** | Reference implementation quality, heavy docs | 8/10 | 8/10 | 3/10 | 7/10 |

### Recommendation

- **MVP**: **A with elements of D**. Solo maintainer with excellent README, clean code, and good examples. Don't optimize for contributors before you have users.
- **Post-MVP**: Move toward B. Open discussions, add CONTRIBUTING.md, label good-first-issues.
- **Defer**: C — don't pretend this is a company-backed product.

---

## 17. README and Launch Strategy

| Variant | Description | First users | Stars | Validates value |
|---------|------------|------------|-------|-----------------|
| **A. Hacker News post** | "Show HN: I built an MCP server for personal finance" | 8/10 | 8/10 | 7/10 |
| **B. Reddit r/ClaudeAI + r/selfhosted** | Community posts with demo | 7/10 | 5/10 | 8/10 |
| **C. Twitter/X thread** | Demo video + thread in AI/dev circles | 6/10 | 7/10 | 5/10 |
| **D. MCP ecosystem listing** | Submit to MCP server directories, awesome-mcp-servers | 7/10 | 6/10 | 6/10 |

### Recommendation

- **Launch**: **D first (low effort, high longevity), then B, then A**. Get listed in MCP directories immediately. Post on r/ClaudeAI with a real usage demo. HN only after you have 50+ stars and real usage — cold HN posts for MCP tools tend to die.
- **README must have**: 1) One-liner pitch, 2) 30-second install, 3) GIF/screenshot of Claude using it, 4) Feature list, 5) Roadmap.
- **Defer**: Twitter threads (low ROI unless you have followers).

---

## 18. Roadmap

### A. Very pragmatic

| Phase | Timeline | Deliverables |
|-------|---------|-------------|
| Week 1 | Day 1-7 | Working MCP server: add/list/delete/update transactions, categories, accounts. npm publishable. |
| Month 1 | Week 2-4 | Summaries, budgets, seed categories, docker-compose, polished README |
| Quarter 1 | Month 2-3 | Recurring transactions, tags, trends, CSV export |

### B. Balanced

| Phase | Timeline | Deliverables |
|-------|---------|-------------|
| Week 1 | Day 1-7 | DB layer + migrations + 6 core tools working locally |
| Month 1 | Week 2-4 | All 11 MVP tools, budgets, tests, npm publish, README, launch on MCP directories |
| Quarter 1 | Month 2-3 | Multi-currency summaries, recurring, import/export, community feedback loop |

### C. Growth-oriented

| Phase | Timeline | Deliverables |
|-------|---------|-------------|
| Week 1 | Day 1-7 | Core tools + beautiful README + demo GIF |
| Month 1 | Week 2-4 | MVP + launch on HN + Reddit + MCP dirs + respond to all issues |
| Quarter 1 | Month 2-3 | Features driven by user requests, blog posts, comparison pages |

### D. Ambitious

| Phase | Timeline | Deliverables |
|-------|---------|-------------|
| Week 1 | Day 1-7 | Full MVP with tests |
| Month 1 | Week 2-4 | Multi-currency, recurring, bank CSV import, plugin system |
| Quarter 1 | Month 2-3 | Multi-DB support, web dashboard, API, mobile app integration |

**Critical take**: D is fantasy. C is risky — optimizing for stars before the product works is backwards. A might ship something unusable (no budgets = toy).

### Recommendation

- **Follow**: **B — Balanced**. Ship quality, then launch. Don't rush to HN with a half-working tool.

---

## 19. Competitive Differentiation

### Landscape

| Competitor type | Examples | Weakness we exploit |
|----------------|---------|---------------------|
| Local MCP trackers | JSON/SQLite file-based, markdown ledgers | No real DB, no multi-device, data loss risk |
| MCP wrappers over SaaS | Mint MCP, YNAB MCP, Plaid MCP | Vendor lock-in, API keys, privacy concerns, subscription cost |
| Generic DB MCP | postgres-mcp, sqlite-mcp | No domain logic, user writes raw SQL, no summaries/budgets |

### Differentiators

| # | Differentiator | Pitch line |
|---|---------------|------------|
| 1 | **SQL-first, self-hosted** | "Your money data in YOUR PostgreSQL. No SaaS, no subscriptions, no API keys." |
| 2 | **Zero-config domain logic** | "Not a generic SQL proxy. Purpose-built for expense tracking with categories, budgets, and summaries." |
| 3 | **Works with any MCP client** | "Claude Desktop, Claude Code, Cursor, Windsurf — if it speaks MCP, it tracks your money." |
| 4 | **One env var to start** | "Set DATABASE_URL. That's the entire setup." |

### README pitch (recommended)

> **mcp-money** — Track expenses and income through your AI assistant.
>
> No spreadsheets. No finance apps. Just tell Claude "I spent $12 on lunch" and it's tracked in your PostgreSQL database with categories, budgets, and summaries.
>
> Self-hosted. Private. SQL-first. One env var to start.

---

## 20. Naming and Branding

| Variant | Name | Tagline | One-liner |
|---------|------|---------|-----------|
| **A** | `mcp-money` | "Your AI-powered expense tracker" | "Track spending through your AI assistant, stored in PostgreSQL" |
| **B** | `cashflow-mcp` | "Personal finance MCP server" | "Tell Claude what you spent. It remembers." |
| **C** | `ledger-mcp` | "AI-native personal ledger" | "Self-hosted expense tracking via MCP protocol" |
| **D** | `mcp-wallet` | "Your AI wallet" | "Let your AI assistant manage your expense tracking" |

### Analysis

- **mcp-money**: Clear, memorable, follows `mcp-*` naming convention. Slightly generic.
- **cashflow-mcp**: Implies more than expense tracking (cash flow analysis). Overpromises for MVP.
- **ledger-mcp**: Sounds like hledger/accounting. Scares casual users. Attracts wrong audience.
- **mcp-wallet**: "Wallet" implies payment/crypto. Confusing.

### Recommendation

- **Best**: **A — `mcp-money`**. Already your repo name. Clear, searchable, follows convention. Not sexy but not confusing.
- **Backup**: B, but only if you commit to cash flow analysis features.
- **Avoid**: C (too accounting-heavy), D (crypto confusion).

### Recommended README opening

```markdown
# mcp-money

Track your expenses and income through any AI assistant that supports MCP.

No spreadsheets. No finance apps. Just tell your AI "I spent $45 on groceries"
and it's stored in your PostgreSQL database — with categories, budgets, and spending summaries.

## Why mcp-money?

- **Self-hosted** — Your financial data stays in your database
- **SQL-first** — PostgreSQL, not JSON files or SQLite
- **Zero config** — One env var: `DATABASE_URL`
- **Smart defaults** — Pre-built categories, monthly budgets, spending summaries
- **Works everywhere** — Claude Desktop, Claude Code, Cursor, any MCP client
```

---

---

# Final Recommendation

| Aspect | Decision |
|--------|----------|
| **Positioning** | Expense tracker for AI assistants |
| **MVP scope** | Transactions + accounts + categories + summaries + basic budgets (11 tools) |
| **Runtime** | Bun-primary, Node-compatible (no Bun-specific APIs in production code) |
| **MCP transport** | stdio only via `@modelcontextprotocol/sdk` |
| **Database** | PostgreSQL only, via Drizzle ORM + postgres.js driver |
| **Schema** | 4 tables: accounts, categories, transactions, budgets. All in `mcp_money` schema. |
| **Migrations** | Auto-migrate on startup with version tracking |
| **Config** | `DATABASE_URL` required. `MCP_MONEY_CURRENCY`, `MCP_MONEY_SCHEMA` optional env vars. |
| **Testing** | Integration tests with real Postgres via `bun test` |
| **Security** | Schema isolation + parameterized queries |
| **Packaging** | npm package, run via `npx mcp-money` |
| **Launch** | MCP directories → Reddit → HN (in that order) |

---

# Implementation Plan

## Phase 0: Repo Bootstrap (Day 1)

**Goals**: Clean project setup, CI, dependencies.

**Tasks**:
- Initialize proper package.json with name, version, description, bin, exports
- Add dependencies: `@modelcontextprotocol/sdk`, `drizzle-orm`, `postgres`
- Add dev dependencies: `drizzle-kit`, `@types/bun`, `typescript`
- Set up tsconfig.json for both Bun and Node compatibility
- Add `.github/workflows/ci.yml` (lint + test)
- Add docker-compose.yml with Postgres for development
- Add proper .gitignore
- Add LICENSE (MIT)

**Deliverables**: Repo that builds and has CI green.

**Risks**: None.

**Done when**: `bun build` succeeds, CI passes.

## Phase 1: Database Layer (Day 2-3)

**Goals**: Schema, migrations, DB connection.

**Tasks**:
- Define Drizzle schema in `src/db/schema.ts`
- Implement auto-migration system with version tracking
- Implement DB connection with `DATABASE_URL`
- Seed default categories
- Write integration tests for schema creation and seeding

**Deliverables**: Running `bun run src/db/migrate.ts` creates all tables in a fresh Postgres.

**Risks**: Drizzle + postgres.js compatibility edge cases across runtimes.

**Done when**: Tests pass creating schema, inserting data, querying data.

## Phase 2: MCP Server Skeleton (Day 3-4)

**Goals**: Working MCP server that responds to tool calls.

**Tasks**:
- Set up MCP server with `@modelcontextprotocol/sdk`
- Register tool definitions with proper JSON schemas
- Implement `StdioServerTransport`
- Add health_check tool
- Implement DB connection lifecycle (connect on start, close on exit)
- Test with Claude Desktop or `mcp-inspector`

**Deliverables**: MCP server starts, lists tools, responds to health_check.

**Risks**: stdio buffering issues across runtimes.

**Done when**: Can connect from Claude Desktop and see tool list.

## Phase 3: Core Tools (Day 4-7)

**Goals**: All 11 MVP tools working.

**Tasks**:
- `add_transaction` — with amount, description, date, category, account
- `list_transactions` — with filters: date range, category, account, limit
- `update_transaction` — update any field
- `delete_transaction` — by ID
- `get_summary` — spending by category for a period, totals, averages
- `list_categories` — all categories
- `create_category` — custom category
- `list_accounts` — all accounts
- `create_account` — new account with type and currency
- `set_budget` — monthly budget for a category
- `get_budget_status` — actual vs budget for current month
- Integration tests for each tool

**Deliverables**: All tools work end-to-end with real Postgres.

**Risks**: Tool input schemas need to be LLM-friendly (good descriptions, sensible defaults). This is iterative.

**Done when**: Can have a natural conversation with Claude: "I spent $50 on groceries" → "How much did I spend this month?" → "Set a $400 food budget" → "Am I over budget?"

## Phase 4: Polish and Release (Day 8-10)

**Goals**: Ship v0.1.0 to npm.

**Tasks**:
- npm package configuration (bin entry point, proper exports)
- Build step for Node.js compatibility (if needed — test with `npx` from npm)
- Write README with: pitch, install, config, usage examples, demo GIF
- Add CHANGELOG.md
- Add CONTRIBUTING.md (minimal)
- Test on Claude Desktop, Claude Code, Cursor
- Publish to npm
- Submit to awesome-mcp-servers, MCP directories

**Deliverables**: `npx mcp-money` works out of the box.

**Risks**: npm publishing, bin entry shebang issues between Bun/Node.

**Done when**: Fresh user can `npx mcp-money` with a DATABASE_URL and start tracking expenses.

## Phase 5: Post-MVP (Month 2+)

**Goals**: Respond to real user feedback.

**Tasks** (tentative, driven by feedback):
- Recurring transactions
- Tags
- CSV import/export
- Spending trends over time
- Multi-currency with optional conversion
- SQLite support via Drizzle

---

# Repository Structure

### Variant A: Flat

```
src/
  index.ts
  db.ts
  schema.ts
  tools.ts
  migrations/
```
Too flat. Hard to navigate as it grows.

### Variant B: By layer

```
src/
  server/
    index.ts
    transport.ts
  db/
    connection.ts
    schema.ts
    migrations/
  tools/
    transactions.ts
    categories.ts
    accounts.ts
    budgets.ts
    summary.ts
    health.ts
  config.ts
```
Clean separation. Easy to find things. Scales well.

### Variant C: By feature

```
src/
  transactions/
    tools.ts
    queries.ts
    schema.ts
  categories/
    tools.ts
    queries.ts
    schema.ts
  budgets/
    tools.ts
    queries.ts
    schema.ts
```
Over-engineered for 4 tables. Creates file explosion.

### Variant D: Minimal + barrel

```
src/
  index.ts        # entry point, MCP server setup
  db/
    index.ts      # connection
    schema.ts     # all tables
    migrate.ts    # migration runner
    seed.ts       # default categories
    migrations/   # SQL files
  tools/
    index.ts      # register all tools
    transactions.ts
    accounts.ts
    categories.ts
    budgets.ts
    summary.ts
    health.ts
  config.ts       # env var parsing
```

### Recommendation: **Variant D**

```
mcp-money/
├── src/
│   ├── index.ts              # entry point: parse config, connect DB, start MCP server
│   ├── config.ts             # env var parsing and validation
│   ├── db/
│   │   ├── connection.ts     # postgres.js connection
│   │   ├── schema.ts         # Drizzle table definitions
│   │   ├── migrate.ts        # auto-migration runner
│   │   ├── seed.ts           # default categories
│   │   └── migrations/       # numbered SQL files
│   │       ├── 001_initial.sql
│   │       └── ...
│   └── tools/
│       ├── index.ts          # tool registry
│       ├── transactions.ts   # add, list, update, delete
│       ├── accounts.ts       # list, create
│       ├── categories.ts     # list, create
│       ├── budgets.ts        # set, get_status
│       ├── summary.ts        # get_summary
│       └── health.ts         # health_check
├── tests/
│   ├── setup.ts              # test DB setup/teardown
│   ├── transactions.test.ts
│   ├── budgets.test.ts
│   └── summary.test.ts
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── docker-compose.yml        # Postgres for dev/test
├── LICENSE
├── README.md
├── CHANGELOG.md
└── CLAUDE.md
```

---

# Task Breakdown

## First 10 tasks

1. Set up package.json with proper fields (name, version, bin, exports, dependencies)
2. Configure tsconfig.json for ESM + both runtimes
3. Create docker-compose.yml with PostgreSQL 16
4. Implement `src/config.ts` — parse DATABASE_URL and optional env vars
5. Define Drizzle schema in `src/db/schema.ts` — all 4 tables
6. Implement `src/db/connection.ts` — postgres.js connection pool
7. Implement `src/db/migrate.ts` — auto-migration with version tracking
8. Write `src/db/migrations/001_initial.sql` — create schema and tables
9. Implement `src/db/seed.ts` — default categories
10. Write first integration test: schema creation + seeding

## Next 10 tasks

11. Implement MCP server skeleton in `src/index.ts`
12. Implement `health_check` tool
13. Implement `add_transaction` tool
14. Implement `list_transactions` tool with filters
15. Implement `update_transaction` and `delete_transaction` tools
16. Implement `list_categories` and `create_category` tools
17. Implement `list_accounts` and `create_account` tools
18. Implement `get_summary` tool (spending by category/period)
19. Implement `set_budget` and `get_budget_status` tools
20. Write integration tests for all tools

## Optional later tasks

21. Write README with usage examples and demo GIF
22. Set up GitHub Actions CI (lint + test with Postgres service)
23. Configure npm publishing (bin entry, shebang, build step)
24. Test on Claude Desktop, Claude Code, Cursor
25. Publish v0.1.0 to npm
26. Submit to awesome-mcp-servers
27. Add recurring transactions
28. Add tags support (via metadata jsonb or dedicated table)
29. Add CSV export tool
30. Add spending trends tool
31. Add multi-currency conversion with external rates API
32. Add SQLite support via Drizzle dialect

---

# Decision Log

## Chose

| Decision | Rationale |
|----------|-----------|
| PostgreSQL only | SQL-first requirement, no local files, Drizzle makes it type-safe |
| Drizzle ORM | Type-safe, multi-dialect ready for future, lightweight |
| postgres.js driver | Works on both Bun and Node, no native bindings |
| stdio-only MCP | 95% of MCP usage is stdio, HTTP is premature |
| Auto-migration on startup | Zero friction for users, critical for adoption |
| 11 tools in MVP | Minimum to be useful, not just a demo |
| Negative amounts for expenses | Simpler math, LLM handles presentation |
| UUID v7 for IDs | Time-sortable, no sequence conflicts |
| `mcp_money` schema | Isolation without requiring dedicated database |
| npm package distribution | Standard MCP installation pattern |
| Monthly-only budgets | 90% use case, simple implementation |
| Seeded default categories | Better UX than empty start |
| `numeric(19,4)` for money | Never float. Industry standard precision. |

## Consciously rejected

| Decision | Reason |
|----------|--------|
| SQLite as primary store | User requirement: no local files |
| Multi-DB support in v1 | Complexity explosion for unproven demand |
| Double-entry bookkeeping | Scares users, solves wrong problem for personal tracking |
| Config file | 3 settings don't justify a config file |
| Docker for MCP server | stdio over Docker is awkward |
| Rate limiting | Absurd for personal finance tool |
| MCP confirmation for deletes | MCP has no native confirmation mechanism |
| Structured logging (pino) | Over-engineered for v1 |
| Event sourcing | 10x complexity for near-zero benefit in personal finance |
| Plugin system | Premature abstraction |

## Deferred to post-MVP

| Feature | When | Trigger |
|---------|------|---------|
| Recurring transactions | v1.1 | User demand |
| Tags | v1.1 | User demand |
| Multi-currency conversion | v1.2 | User demand + good rate API found |
| CSV import/export | v1.1 | Obvious early request |
| Spending trends | v1.2 | After summaries prove useful |
| SQLite support | v2.0 | If Postgres is blocking adoption |
| HTTP/SSE transport | v2.0 | When MCP clients support it widely |
| Web dashboard | Never (probably) | Out of scope for MCP server |

## Decisions to re-evaluate after MVP

| Decision | Re-evaluate when |
|----------|-----------------|
| PostgreSQL-only | If >30% of issues are "how do I set up Postgres" |
| Amount sign convention | If users/LLMs are confused by negative amounts |
| Auto-migration | If any user reports data loss |
| Drizzle ORM | If it causes runtime issues on Node |
| Tool count | If LLMs struggle with 11 tools (reduce) or users ask for more (expand) |
| Monthly-only budgets | If >5 requests for weekly/quarterly |
| UUID v7 | If any driver compatibility issues |
