const isDebug = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export function log(message: string): void {
  process.stderr.write(`[mcp-money] ${message}\n`);
}

export function debug(message: string): void {
  if (isDebug) {
    process.stderr.write(`[mcp-money:debug] ${message}\n`);
  }
}
