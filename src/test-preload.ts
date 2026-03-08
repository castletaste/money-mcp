// Preload: set test schema env BEFORE any module imports schema.ts
// All test files share the same module cache in bun, so they must use the same schema.
process.env.MCP_MONEY_SCHEMA = `mcp_money_test_${process.pid}`;
