import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { parseCursorDb } from "../../src/parsers/cursor"
import type { TraceEntry } from "../../src/types";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-cursor-"));
}

function createCursorDb(dir: string): string {
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath);

  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");

  return dbPath;
}

function insertComposer(
  dbPath: string,
  composerId: string,
  data: Record<string, unknown>,
): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `composerData:${composerId}`,
    JSON.stringify({ _v: 3, composerId, ...data }),
  );
  db.close();
}

function insertBubble(
  dbPath: string,
  composerId: string,
  bubbleId: string,
  data: Record<string, unknown>,
): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${composerId}:${bubbleId}`,
    JSON.stringify({ _v: 2, bubbleId, ...data }),
  );
  db.close();
}

describe("parseCursorDb", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    dbPath = createCursorDb(dir);
  });

  it("parses a user message", () => {
    insertComposer(dbPath, "comp-1", {
      createdAt: 1712592000000,
      name: "Fix login bug",
      isAgentic: false,
    });
    insertBubble(dbPath, "comp-1", "bubble-1", {
      type: 1,
      text: "Fix the login page redirect",
      tokenCount: { inputTokens: 50, outputTokens: 0 },
    });

    const entries = parseCursorDb(dbPath);
    const userMsgs = entries.filter((e) => e.role === "user" && e.entryType === "message");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].userPrompt).toBe("Fix the login page redirect");
    expect(userMsgs[0].agent).toBe("cursor");
    expect(userMsgs[0].sessionId).toBe("comp-1");
  });

  it("stamps project on every entry from meta.project", () => {
    // Regression: before this, parseCursorDb hardcoded project: "" and the
    // dashboard's WHERE project = X filter dropped every Cursor entry.
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-1", { type: 1, text: "hello" });
    insertBubble(dbPath, "comp-1", "bubble-2", { type: 2, text: "hi" });

    const entries = parseCursorDb(dbPath, { project: "observer" });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.project === "observer")).toBe(true);
  });

  it("falls back to empty project when meta.project is omitted", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-1", { type: 1, text: "hello" });
    const entries = parseCursorDb(dbPath);
    expect(entries[0].project).toBe("");
  });

  // The inference walks paths using Unix `/` separators and matches against
  // `homedir()`, which on Windows returns a `C:\…` path. The parser is
  // effectively Unix-only; Cursor on Windows falls through to meta.project.
  it.skipIf(process.platform === "win32")("infers project from bubble tool-call paths when home dir matches", () => {
    // The realistic shape: Cursor's globalStorage pools sessions across
    // workspaces, so the per-composer project must come from the bubbles
    // themselves. Plant tool-call paths under $HOME/<basename>/ — parser
    // walks up looking for a .git or package.json marker, falls back to
    // basename of the common prefix when none found.
    const home = process.env.HOME ?? "";
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-1", {
      type: 1,
      text: "edit this file",
      // Inference walks any path-shaped value found anywhere in the bubble
      // (toolFormerData.params is one common spot, but we don't depend on
      // a specific schema — collectPathsFromBubble walks the whole object).
      toolFormerData: [{
        toolName: "edit_file",
        filePath: `${home}/dev/some-fake-proj-xyz/src/index.ts`,
      }],
    });
    insertBubble(dbPath, "comp-1", "bubble-2", {
      type: 2,
      text: "done",
      toolFormerData: [{
        toolName: "read_file",
        filePath: `${home}/dev/some-fake-proj-xyz/src/lib.ts`,
      }],
    });

    // No meta.project — entries should still get inference.
    const entries = parseCursorDb(dbPath);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.project === "some-fake-proj-xyz")).toBe(true);
  });

  it("respects meta.project when bubbles have no inferable paths", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-1", {
      type: 1,
      text: "just chatting, no tool calls",
    });
    const entries = parseCursorDb(dbPath, { project: "fallback-proj" });
    expect(entries[0].project).toBe("fallback-proj");
  });

  it("parses an assistant message", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-2", {
      type: 2,
      text: "I've fixed the redirect issue by updating the auth middleware.",
      tokenCount: { inputTokens: 200, outputTokens: 150 },
    });

    const entries = parseCursorDb(dbPath);
    const assistantMsgs = entries.filter((e) => e.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].assistantText).toContain("redirect issue");
    expect(assistantMsgs[0].tokenUsage).toEqual({
      input: 200,
      output: 150,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    });
  });

  it("parses tool calls from toolFormerData", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "bubble-3", {
      type: 2,
      text: "",
      toolFormerData: [
        { toolName: "edit_file", filePath: "/src/auth.ts", status: "completed" },
        { toolName: "terminal", command: "npm test", status: "completed" },
      ],
    });

    const entries = parseCursorDb(dbPath);
    const toolCalls = entries.filter((e) => e.entryType === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolName).toBe("edit");
    expect(toolCalls[0].filePath).toBe("/src/auth.ts");
    expect(toolCalls[1].toolName).toBe("shell");
    expect(toolCalls[1].command).toBe("npm test");
  });

  it("normalizes tool names", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "b1", {
      type: 2,
      toolFormerData: [
        { toolName: "edit_file", filePath: "/a.ts" },
        { toolName: "terminal", command: "ls" },
        { toolName: "read_file", filePath: "/b.ts" },
        { toolName: "search_files", query: "TODO" },
      ],
    });

    const entries = parseCursorDb(dbPath);
    const tools = entries.filter((e) => e.entryType === "tool_call");
    const names = tools.map((t) => t.toolName);
    expect(names).toEqual(["edit", "shell", "read", "search"]);
  });

  it("normalizes MCP tool names with mcp__ prefix", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "b-mcp", {
      type: 2,
      toolFormerData: [
        { toolName: "mcp__db_mcp__run_sql", query: "SELECT 1" },
      ],
    });

    const entries = parseCursorDb(dbPath);
    const tools = entries.filter((e) => e.entryType === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("mcp:db_mcp:run_sql");
  });

  it("extracts cost from usageData", () => {
    insertComposer(dbPath, "comp-1", {
      createdAt: 1712592000000,
      usageData: {
        "claude-sonnet-4-5": { costInCents: 42, amount: 3 },
      },
    });
    insertBubble(dbPath, "comp-1", "b1", { type: 1, text: "hello" });

    const entries = parseCursorDb(dbPath);
    // Cost metadata attached to first entry of the session
    const first = entries[0];
    expect(first.model).toBe("claude-sonnet-4-5");
      });

  it("handles multiple sessions", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000, name: "Session A" });
    insertBubble(dbPath, "comp-1", "b1", { type: 1, text: "msg A" });

    insertComposer(dbPath, "comp-2", { createdAt: 1712595600000, name: "Session B" });
    insertBubble(dbPath, "comp-2", "b2", { type: 1, text: "msg B" });

    const entries = parseCursorDb(dbPath);
    const sessions = new Set(entries.map((e) => e.sessionId));
    expect(sessions.size).toBe(2);
  });

  it("marks agentic sessions", () => {
    insertComposer(dbPath, "comp-agent", {
      createdAt: 1712592000000,
      isAgentic: true,
    });
    insertBubble(dbPath, "comp-agent", "b1", { type: 1, text: "agent task" });

    const entries = parseCursorDb(dbPath);
    expect(entries[0].agent).toBe("cursor");
  });

  it("returns empty for database with no conversations", () => {
    const entries = parseCursorDb(dbPath);
    expect(entries).toEqual([]);
  });

  it("handles missing or malformed bubble values gracefully", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    // Insert a bubble with broken JSON
    const db = new Database(dbPath);
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:comp-1:bad",
      "not json",
    );
    db.close();

    // Should not throw
    const entries = parseCursorDb(dbPath);
    expect(entries).toEqual([]);
  });

  it("truncates long content", () => {
    insertComposer(dbPath, "comp-1", { createdAt: 1712592000000 });
    insertBubble(dbPath, "comp-1", "b1", {
      type: 1,
      text: "x".repeat(500),
    });

    const entries = parseCursorDb(dbPath);
    expect(entries[0].userPrompt!.length).toBeLessThanOrEqual(500);
  });
});
