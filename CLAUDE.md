
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Project specifics

- MCP server using `@modelcontextprotocol/sdk` with stdio transport
- PostgreSQL via `postgres` (postgres.js) + `drizzle-orm` — NOT Bun.sql (for Node compatibility)
- Schema defined in `src/db/schema.ts`, auto-migration in `src/db/migrate.ts`
- Tools organized in `src/tools/` (categories, tags, transactions, summary, budgets, utils)
- All tools registered in `src/server.ts`
- Entry point: `src/index.ts`, CLI wrapper: `bin/mcp-money.js`

## Testing

Use `bun test` to run tests. Tests are integration tests requiring a running PostgreSQL instance.

```bash
DATABASE_URL=postgresql://... bun test
```

## Key conventions

- `numeric(19,4)` for monetary amounts, never float
- UUID v7 for sortable IDs
- Negative amounts = expense, positive = income
- Each transaction stores its own currency
- All tables live in configurable PostgreSQL schema (default: `mcp_money`)
