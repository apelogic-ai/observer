import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getSearchToEditRatio, getFirstActionLatency } from "../../server/queries";

/**
 * Two session-efficiency metrics shipped together:
 *
 *   - getSearchToEditRatio: per session, how many read-shaped tool
 *     calls (Read / grep / find / ls / list / search) vs edit-shaped
 *     ones. Ratio = reads / edits. High = the agent thrashed before
 *     making one small change ("navigation friction" — repo lacks
 *     discoverable structure / docs).
 *
 *   - getFirstActionLatency: per session, time from the first user
 *     message to the first useful action (edit, validation tool
 *     call, or agent commit). Long latencies = the agent
 *     over-explored before doing anything.
 *
 * Both filter to sessions where at least one edit happened — pure
 * exploration sessions and chat-only sessions don't carry the
 * signal we want to measure.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = (h: number, m = 0, s = 0) =>
  `${TODAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}Z`;

beforeAll(async () => {
  process.env.OBSERVER_TEST_ALLOW_FOREIGN_FILTER_BYPASS = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-efficiency-"));

  // Session A — heavy navigation: 8 reads (Read, grep, find), 2 edits.
  // Ratio = 4. Realistic: the agent grep'd around a lot before
  // making a small change.
  writeJsonl(join(dataDir, TODAY, "claude_code", "thrash.jsonl"), [
    { id: "tu", timestamp: T(9, 0), agent: "claude_code", sessionId: "thrash",
      project: "alpha", entryType: "message", role: "user", userPrompt: "fix the bug" },
    ...readCalls("thrash", "alpha", T(9, 1), 8),
    ...editCalls("thrash", "alpha", T(9, 30), 2),
  ]);

  // Session B — focused: 2 reads, 5 edits. Ratio = 0.4. Got the
  // job done with minimal exploration.
  writeJsonl(join(dataDir, TODAY, "claude_code", "focused.jsonl"), [
    { id: "fu", timestamp: T(10, 0), agent: "claude_code", sessionId: "focused",
      project: "beta", entryType: "message", role: "user", userPrompt: "add feature x" },
    ...readCalls("focused", "beta", T(10, 1), 2),
    ...editCalls("focused", "beta", T(10, 5), 5),
  ]);

  // Session C — pure exploration, no edits. Should NOT appear in
  // either query.
  writeJsonl(join(dataDir, TODAY, "claude_code", "explore.jsonl"), [
    { id: "eu", timestamp: T(11, 0), agent: "claude_code", sessionId: "explore",
      project: "alpha", entryType: "message", role: "user", userPrompt: "look around" },
    ...readCalls("explore", "alpha", T(11, 1), 5),
  ]);

  // Session D — slow start: user message at 12:00, first edit at
  // 12:30. firstActionLatency = 30 minutes = 1800 seconds.
  writeJsonl(join(dataDir, TODAY, "claude_code", "slow.jsonl"), [
    { id: "su", timestamp: T(12, 0), agent: "claude_code", sessionId: "slow",
      project: "gamma", entryType: "message", role: "user", userPrompt: "go" },
    // 20 minutes of nothing-but-reads (over-exploring).
    ...readCalls("slow", "gamma", T(12, 5), 4),
    ...editCalls("slow", "gamma", T(12, 30), 1),
  ]);

  // Session E — quick: user message + edit within 30 seconds.
  writeJsonl(join(dataDir, TODAY, "claude_code", "quick.jsonl"), [
    { id: "qu", timestamp: T(13, 0, 0), agent: "claude_code", sessionId: "quick",
      project: "delta", entryType: "message", role: "user", userPrompt: "fix typo" },
    ...editCalls("quick", "delta", T(13, 0, 30), 1),
  ]);

  await initDb(dataDir);
});

function readCalls(sessionId: string, project: string, startAt: string, n: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // Cycle a few read-shaped tool names so the matcher coverage shows.
  const names = ["Read", "Bash", "Bash", "Bash"];
  const cmds  = [null, "grep -r foo .", "find . -name '*.ts'", "ls -la"];
  const baseMs = new Date(startAt).getTime();
  for (let i = 0; i < n; i++) {
    const idx = i % names.length;
    rows.push({
      id: `${sessionId}-r-${i}`, timestamp: new Date(baseMs + i * 30_000).toISOString(),
      agent: "claude_code", sessionId, project,
      entryType: "tool_call", role: "assistant",
      toolName: names[idx], command: cmds[idx],
    });
  }
  return rows;
}

function editCalls(sessionId: string, project: string, startAt: string, n: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const baseMs = new Date(startAt).getTime();
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `${sessionId}-e-${i}`, timestamp: new Date(baseMs + i * 30_000).toISOString(),
      agent: "claude_code", sessionId, project,
      entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: `src/file-${i}.ts`,
    });
  }
  return rows;
}

describe("getSearchToEditRatio", () => {
  it("counts read-shaped + edit-shaped tool calls per session", async () => {
    const rows = await getSearchToEditRatio({ days: 1 });
    const thrash = rows.find((r) => r.sessionId === "thrash")!;
    expect(thrash.reads).toBe(8);
    expect(thrash.edits).toBe(2);
    const focused = rows.find((r) => r.sessionId === "focused")!;
    expect(focused.reads).toBe(2);
    expect(focused.edits).toBe(5);
  });

  it("derives ratio = reads / edits", async () => {
    const rows = await getSearchToEditRatio({ days: 1 });
    const thrash = rows.find((r) => r.sessionId === "thrash")!;
    expect(thrash.ratio).toBe(4);  // 8 / 2
    const focused = rows.find((r) => r.sessionId === "focused")!;
    expect(focused.ratio).toBe(0.4);  // 2 / 5
  });

  it("excludes sessions with zero edits", async () => {
    const rows = await getSearchToEditRatio({ days: 1 });
    expect(rows.find((r) => r.sessionId === "explore")).toBeUndefined();
  });

  it("sorts by ratio descending (most navigation friction first)", async () => {
    const rows = await getSearchToEditRatio({ days: 1 });
    const ratios = rows.map((r) => r.ratio);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
  });

  it("recognizes Bash/shell with grep/find/ls commands as reads", async () => {
    // The thrash fixture seeds 8 read-shaped calls of which 6 are
    // Bash with grep/find/ls commands (only 2 are tool=Read).
    // If the matcher only looked at toolName, reads would be 2.
    const rows = await getSearchToEditRatio({ days: 1 });
    expect(rows.find((r) => r.sessionId === "thrash")!.reads).toBe(8);
  });
});

describe("getFirstActionLatency", () => {
  it("measures seconds between first user message and first edit", async () => {
    const rows = await getFirstActionLatency({ days: 1 });
    // slow: user at 12:00:00, first edit at 12:30:00 = 1800s
    const slow = rows.find((r) => r.sessionId === "slow")!;
    expect(slow.latencyMs).toBe(30 * 60 * 1000);
    // quick: 30s gap
    const quick = rows.find((r) => r.sessionId === "quick")!;
    expect(quick.latencyMs).toBe(30 * 1000);
  });

  it("excludes sessions that never edited (no useful-action signal)", async () => {
    const rows = await getFirstActionLatency({ days: 1 });
    expect(rows.find((r) => r.sessionId === "explore")).toBeUndefined();
  });

  it("sorts by latency descending (over-explorers first)", async () => {
    const rows = await getFirstActionLatency({ days: 1 });
    const ms = rows.map((r) => r.latencyMs);
    expect(ms).toEqual([...ms].sort((a, b) => b - a));
  });

  it("respects project + agent filters on both queries", async () => {
    const beta = await getSearchToEditRatio({ days: 1, project: "beta" });
    expect(beta.map((r) => r.sessionId)).toEqual(["focused"]);
    const delta = await getFirstActionLatency({ days: 1, project: "delta" });
    expect(delta.map((r) => r.sessionId)).toEqual(["quick"]);
  });
});
