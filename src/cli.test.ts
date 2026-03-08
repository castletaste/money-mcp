import { test, expect, describe } from "bun:test";
import { resolve, join } from "node:path";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");

describe("CLI entry point", () => {
  test("bin/mcp-money.js exists", () => {
    expect(existsSync(join(ROOT, "bin/mcp-money.js"))).toBe(true);
  });

  test("bin/mcp-money.js has bun shebang", () => {
    const content = readFileSync(join(ROOT, "bin/mcp-money.js"), "utf-8");
    expect(content.startsWith("#!/usr/bin/env bun")).toBe(true);
  });

  test("bin/mcp-money.js is executable", () => {
    expect(() =>
      accessSync(join(ROOT, "bin/mcp-money.js"), constants.X_OK),
    ).not.toThrow();
  });

  test("bin/mcp-money.js imports src/index.ts", () => {
    const content = readFileSync(join(ROOT, "bin/mcp-money.js"), "utf-8");
    expect(content).toContain("../src/index.ts");
  });
});

describe("package.json for npm publishing", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  test("name is mcp-money", () => {
    expect(pkg.name).toBe("mcp-money");
  });

  test("bin points to bin/mcp-money.js", () => {
    expect(pkg.bin["mcp-money"]).toBe("./bin/mcp-money.js");
  });

  test("files includes bin/ and src/", () => {
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).toContain("src/");
  });

  test("exports has main entry", () => {
    expect(pkg.exports["."]).toBe("./src/index.ts");
  });

  test("type is module", () => {
    expect(pkg.type).toBe("module");
  });

  test("has required dependencies", () => {
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(pkg.dependencies["postgres"]).toBeDefined();
    expect(pkg.dependencies["zod"]).toBeDefined();
  });
});

describe("CLI process", () => {
  test("exits with error when DATABASE_URL is missing", async () => {
    const proc = Bun.spawn(["bun", join(ROOT, "bin/mcp-money.js")], {
      env: { ...process.env, DATABASE_URL: undefined },
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);

    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("DATABASE_URL");
  });
});
