import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getIncidents } from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = new Date(Date.now() - 3 * 3600_000).toISOString();

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-incidents-"));

  // Session s1: 5 near-identical `grep foo <path>` calls — one incident.
  // Session s2: 4 distinct commands, no repetition — no incident.
  // Session s3: 3 reads of the same file — these get FILTERED OUT
  //             (file edits/reads are normal iteration, not loops).
  // Session s4: 2 `ls` calls — below threshold (≥3), no incident.
  // Session s5: 4 reads of CLAUDE.md + 5 invocations of an MCP tool with
  //             same query — only the MCP one counts as an incident.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s1.jsonl"), [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `s1-grep-${i}`, timestamp: new Date(Date.parse(T0) + i * 1000).toISOString(),
      agent: "claude_code", sessionId: "s1", project: "alpha",
      entryType: "tool_call", toolName: "Bash",
      command: `grep foo /var/path${i}/`,
      tokenUsage: { input: 100, output: 20 },
    })),
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s2.jsonl"), [
    { id: "s2-a", timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "ls -la", tokenUsage: { input: 50, output: 10 } },
    { id: "s2-b", timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "alpha", entryType: "tool_call", toolName: "Bash",
      command: "git status", tokenUsage: { input: 50, output: 10 } },
    { id: "s2-c", timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "alpha", entryType: "tool_call", toolName: "Read",
      filePath: "/x/a.ts", tokenUsage: { input: 200, output: 0 } },
    { id: "s2-d", timestamp: T0, agent: "claude_code", sessionId: "s2",
      project: "alpha", entryType: "tool_call", toolName: "Edit",
      filePath: "/x/a.ts", tokenUsage: { input: 200, output: 0 } },
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s3.jsonl"), [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `s3-read-${i}`, timestamp: new Date(Date.parse(T0) + i * 1000).toISOString(),
      agent: "claude_code", sessionId: "s3", project: "beta",
      entryType: "tool_call", toolName: "Read",
      filePath: "/repo/CLAUDE.md",
      tokenUsage: { input: 1000, output: 0 },
    })),
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s4.jsonl"), [
    { id: "s4-a", timestamp: T0, agent: "claude_code", sessionId: "s4",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: "ls" },
    { id: "s4-b", timestamp: T0, agent: "claude_code", sessionId: "s4",
      project: "beta", entryType: "tool_call", toolName: "Bash",
      command: "ls" },
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s5.jsonl"), [
    // 4 reads — should get filtered (Read is iteration, not a loop).
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `s5-r-${i}`, timestamp: T0, agent: "claude_code", sessionId: "s5",
      project: "alpha", entryType: "tool_call", toolName: "Read",
      filePath: "/repo/CLAUDE.md", tokenUsage: { input: 1000, output: 0 },
    })),
    // 5 MCP invocations — should surface as an incident.
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `s5-mcp-${i}`, timestamp: T0, agent: "claude_code", sessionId: "s5",
      project: "alpha", entryType: "tool_call",
      toolName: "mcp__db_mcp__shell",
      command: `SELECT * FROM events WHERE day='2026-04-2${i}'`,
      tokenUsage: { input: 500, output: 100 },
    })),
  ]);

  await initDb(DATA_DIR);
});

describe("getIncidents", () => {
  it("surfaces non-iteration tools repeated ≥3 times in one session", async () => {
    const incidents = await getIncidents({ days: 30 }, 50);

    // s1 grep cluster + s5 MCP cluster. s3's Read repetition gets filtered
    // (Edit/Read/Write are normal iteration, not loops). s2/s4 don't qualify.
    expect(incidents.length).toBe(2);

    const grep = incidents.find((i) => i.sessionId === "s1");
    expect(grep).toBeDefined();
    expect(grep!.toolName).toBe("Bash");
    expect(grep!.agent).toBe("claude_code");
    expect(grep!.shape).toContain("grep foo");
    expect(grep!.shape).toContain("<path>");
    expect(grep!.occurrences).toBe(5);
    // 5 × (100+20) = 600 — for sessions whose tool calls do carry tokens.
    expect(grep!.tokens).toBe(600);
    // Session totals match per-tool totals here because s1 has only tool calls.
    expect(grep!.sessionTokens).toBe(600);

    const mcp = incidents.find((i) => i.sessionId === "s5");
    expect(mcp).toBeDefined();
    expect(mcp!.toolName).toBe("mcp__db_mcp__shell");
    expect(mcp!.occurrences).toBe(5);
    // s5 has 4 reads × 1000 + 5 mcp × 600 = 7000 session-wide.
    expect(mcp!.sessionTokens).toBe(7000);

    // Filtered out: file iteration tools (Read in s3) and below-threshold.
    expect(incidents.find((i) => i.sessionId === "s3")).toBeUndefined();
    expect(incidents.find((i) => i.sessionId === "s4")).toBeUndefined();
    expect(incidents.find((i) => i.sessionId === "s2")).toBeUndefined();

    // Top incident has the highest occurrence count (tied at 5 — s1 wins by token tiebreak).
    expect(incidents[0]!.occurrences).toBe(5);
  });

  it("respects the limit argument", async () => {
    const incidents = await getIncidents({ days: 30 }, 1);
    expect(incidents.length).toBe(1);
  });

  it("filter tool='*mcp' narrows to MCP tools only (matches both 'mcp:' and 'mcp__' naming)", async () => {
    const incidents = await getIncidents({ days: 30, tool: "*mcp" }, 50);
    expect(incidents.length).toBe(1);
    expect(incidents[0]!.toolName).toBe("mcp__db_mcp__shell");
  });
});
