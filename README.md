# mcp-money

MCP server for personal finance tracking. Designed for AI assistants — track expenses, income, budgets, and get financial summaries through 16 MCP tools.

Uses PostgreSQL with Drizzle ORM. Auto-migrates on startup.

## Installation

```bash
npx mcp-money
```

Or with Bun:

```bash
bunx mcp-money
```

## Configuration

Add to your MCP client config (e.g. Claude Desktop):

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

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `MCP_MONEY_SCHEMA` | No | `mcp_money` | PostgreSQL schema name |
| `DEBUG` | No | `false` | Enable SQL query logging to stderr |

## Tools (16)

### Transactions

| Tool | Description |
|------|-------------|
| `add_transaction` | Record an expense or income. Expenses stored as negative amounts. Tags created on-the-fly. |
| `list_transactions` | List with filters: date range, category, tag, currency. Supports limit/offset pagination. |
| `update_transaction` | Partial update of any field including tags. |
| `delete_transaction` | Hard delete a transaction. |

### Categories

| Tool | Description |
|------|-------------|
| `list_categories` | List all categories grouped by type (expense/income). |
| `create_category` | Create a category with name, type, optional parent (one nesting level). |
| `delete_category` | Delete a category. Fails if transactions reference it (RESTRICT). |

### Tags

| Tool | Description |
|------|-------------|
| `list_tags` | List all tags. |
| `create_tag` | Create a tag with a unique name. |
| `delete_tag` | Delete a tag and all transaction associations (CASCADE). |

### Summary

| Tool | Description |
|------|-------------|
| `get_summary` | Financial summary for a date range: expenses by category, totals and averages per currency. |

### Budgets

| Tool | Description |
|------|-------------|
| `set_budget` | Set or update a monthly budget for a category. |
| `get_budget_status` | Check budget vs actual spending for a month. Multi-currency aware. |
| `delete_budget` | Delete a budget by ID. |

### Utilities

| Tool | Description |
|------|-------------|
| `set_currency` | Set the default currency for new transactions (e.g. USD, EUR, RUB). |
| `health_check` | Check DB connection, schema version, and statistics. |

## Multi-currency

Every transaction stores its own currency. The default currency (initially `USD`) can be changed via `set_currency`. Summaries and budget statuses group by currency — no cross-currency conversion.

## Default categories

On first run, ~10 categories are seeded: Groceries, Restaurants, Transport, Entertainment, Utilities, Rent, Salary, Healthcare, Shopping, Other.

## Development

```bash
bun install
bun run dev        # watch mode
bun test           # run tests
```

Requires a running PostgreSQL instance. Set `DATABASE_URL` in `.env`.

## License

ISC
