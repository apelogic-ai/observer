import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getPermissions } from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = `${TODAY}T09:00:00Z`;
const T1 = `${TODAY}T10:00:00Z`;
const T2 = `${TODAY}T11:00:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-perms-"));

  // Project alpha — typical mixed work in one session.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "alpha-1.jsonl"), [
    // 3 git status, 2 git diff → "git" appears 5×
    { id: "g1", timestamp: T0, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git status" },
    { id: "g2", timestamp: T0, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git status -sb" },
    { id: "g3", timestamp: T0, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git status" },
    { id: "g4", timestamp: T0, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git diff" },
    { id: "g5", timestamp: T0, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git diff HEAD~1" },
    // bun test 4× — build/test category
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `bt${i}`, timestamp: T1, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "bun test packages/dashboard",
    })),
    // Read 7× on TS files
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`, timestamp: T2, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "Read",
      filePath: `/repo/src/file${i}.ts`,
    })),
    // 1 MCP call
    { id: "m1", timestamp: T2, agent: "claude_code", sessionId: "s-alpha-1",
      project: "alpha", entryType: "tool_call", toolName: "mcp:db-mcp:shell",
      command: "SELECT 1" },
  ]);

  // Project ghost — pathological commands that exercise the
  // shell-metachar / env-prefix / lowercase-tool emission rules.
  // Kept under a unique project name so existing per-verb counts
  // (bun=4, git=5, etc.) don't shift.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "ghost-1.jsonl"), [
    // Verb captured as `PID=$(lsof` — would emit Bash(PID=$(lsof:*),
    // mismatched parens. Should be dropped entirely.
    { id: "gh1", timestamp: T0, agent: "claude_code", sessionId: "s-ghost",
      project: "ghost", entryType: "tool_call", toolName: "Bash",
      command: "PID=$(lsof -ti :3000)" },
    // Env-var prefix should be stripped — verb is `npm`.
    { id: "gh2", timestamp: T0, agent: "claude_code", sessionId: "s-ghost",
      project: "ghost", entryType: "tool_call", toolName: "Bash",
      command: "LC_ALL=C npm test" },
    // Lowercase tool name `shell` must round-trip to PascalCase
    // `Shell(ps:*)` per Claude Code's settings.json grammar.
    { id: "gh3", timestamp: T0, agent: "claude_code", sessionId: "s-ghost",
      project: "ghost", entryType: "tool_call", toolName: "shell",
      command: "ps aux" },
    // Same lowercase rule for non-shell tools — emit `Stdin`.
    { id: "gh4", timestamp: T0, agent: "claude_code", sessionId: "s-ghost",
      project: "ghost", entryType: "tool_call", toolName: "stdin" },
  ]);

  // Project beta — different work, different session.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "beta-1.jsonl"), [
    // 2 grep
    { id: "p1", timestamp: T0, agent: "claude_code", sessionId: "s-beta-1",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: "grep -r foo src/" },
    { id: "p2", timestamp: T0, agent: "claude_code", sessionId: "s-beta-1",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: "grep bar lib/" },
    // 1 uv
    { id: "u1", timestamp: T1, agent: "claude_code", sessionId: "s-beta-1",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: "uv run pytest tests/" },
  ]);

  await initDb(DATA_DIR);
});

describe("getPermissions", () => {
  it("returns categorized command permissions", async () => {
    const rows = await getPermissions({ days: 30 });
    expect(rows.length).toBeGreaterThan(0);

    // Each entry has the required fields.
    for (const r of rows) {
      expect(r.category).toMatch(/^(core|build|file|mcp|other)$/);
      expect(r.tool).toBeTruthy();
      expect(r.count).toBeGreaterThan(0);
      expect(r.sessions).toBeGreaterThan(0);
      expect(r.allowlistEntry).toBeTruthy();
    }
  });

  it("rolls Bash up to a verb-level entry (depth=1)", async () => {
    const rows = await getPermissions({ days: 30 });
    const git = rows.find((r) => r.tool === "Bash" && r.path.length === 2 && r.path[1] === "git");
    expect(git).toBeDefined();
    expect(git!.count).toBe(5);              // 3 status + 2 diff
    expect(git!.category).toBe("core");
    expect(git!.allowlistEntry).toBe("Bash(git:*)");
  });

  it("also produces verb+subcommand entries (depth=2) for Bash", async () => {
    const rows = await getPermissions({ days: 30 });
    const status = rows.find((r) => r.tool === "Bash" && r.path.join(" ") === "Bash git status");
    expect(status).toBeDefined();
    expect(status!.count).toBe(3);
    expect(status!.allowlistEntry).toBe("Bash(git status:*)");
    const diff = rows.find((r) => r.tool === "Bash" && r.path.join(" ") === "Bash git diff");
    expect(diff).toBeDefined();
    expect(diff!.count).toBe(2);
  });

  it("classifies bun and uv as build/test, not core", async () => {
    const rows = await getPermissions({ days: 30 });
    const bun = rows.find((r) => r.tool === "Bash" && r.path[1] === "bun");
    expect(bun).toBeDefined();
    expect(bun!.category).toBe("build");
    expect(bun!.count).toBe(4);
    const uv = rows.find((r) => r.tool === "Bash" && r.path[1] === "uv");
    expect(uv).toBeDefined();
    expect(uv!.category).toBe("build");
  });

  it("emits a single entry per file-tool (Read), category=file", async () => {
    const rows = await getPermissions({ days: 30 });
    const read = rows.find((r) => r.tool === "Read" && r.path.length === 1);
    expect(read).toBeDefined();
    expect(read!.count).toBe(7);
    expect(read!.category).toBe("file");
    expect(read!.allowlistEntry).toBe("Read");
  });

  it("emits MCP tools under their own category", async () => {
    const rows = await getPermissions({ days: 30 });
    const mcp = rows.find((r) => r.tool === "mcp:db-mcp:shell");
    expect(mcp).toBeDefined();
    expect(mcp!.category).toBe("mcp");
    expect(mcp!.allowlistEntry).toBe("mcp:db-mcp:shell");
  });

  it("filters by project — beta has grep + uv but not git/bun/Read", async () => {
    const rows = await getPermissions({ days: 30, project: "beta" });
    expect(rows.find((r) => r.path[1] === "grep")).toBeDefined();
    expect(rows.find((r) => r.path[1] === "uv")).toBeDefined();
    expect(rows.find((r) => r.path[1] === "git")).toBeUndefined();
    expect(rows.find((r) => r.path[1] === "bun")).toBeUndefined();
    expect(rows.find((r) => r.tool === "Read")).toBeUndefined();
  });

  it("drops bash rows whose verb contains shell metacharacters", async () => {
    const rows = await getPermissions({ days: 30, project: "ghost" });
    // No row should contain unbalanced parens or `$(...)` constructs in
    // its allowlistEntry. Claude Code rejects those at config-load time.
    for (const r of rows) {
      expect(r.allowlistEntry).not.toMatch(/[$`]|\(.*\(/);
      // `(` count must equal `)` count — except for the lone `:*)` suffix.
      const opens = (r.allowlistEntry.match(/\(/g) ?? []).length;
      const closes = (r.allowlistEntry.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(rows.find((r) => r.path[1]?.includes("$") || r.path[1]?.includes("("))).toBeUndefined();
  });

  it("strips leading env-var assignments before picking the bash verb", async () => {
    const rows = await getPermissions({ days: 30, project: "ghost" });
    // `LC_ALL=C npm test` → the verb is `npm`, not `LC_ALL=C`.
    expect(rows.find((r) => r.tool === "Bash" && r.path[1] === "npm")).toBeDefined();
    expect(rows.find((r) => r.path[1]?.includes("="))).toBeUndefined();
  });

  it("emits PascalCase tool names so Claude Code accepts the entry", async () => {
    const rows = await getPermissions({ days: 30, project: "ghost" });
    const sh = rows.find((r) => r.path[0] === "Shell" || r.tool === "Shell");
    expect(sh, "expected the lowercase 'shell' tool to surface as 'Shell'").toBeDefined();
    expect(sh!.allowlistEntry.startsWith("Shell(")).toBe(true);
    const stdin = rows.find((r) => r.tool === "Stdin");
    expect(stdin, "expected lowercase 'stdin' to surface as 'Stdin'").toBeDefined();
    expect(stdin!.allowlistEntry).toBe("Stdin");
    // No emitted entry should start with a lowercase letter.
    for (const r of rows) {
      expect(r.allowlistEntry[0]).toMatch(/[A-Z]|m/); // mcp__/mcp: are special
    }
  });

  it("sorts within category by count desc", async () => {
    const rows = await getPermissions({ days: 30 });
    const core = rows.filter((r) => r.category === "core" && r.path.length === 2);
    for (let i = 1; i < core.length; i++) {
      expect(core[i - 1]!.count).toBeGreaterThanOrEqual(core[i]!.count);
    }
  });
});
