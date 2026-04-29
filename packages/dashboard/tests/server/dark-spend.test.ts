import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getDarkSpend } from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = `${TODAY}T09:00:00Z`;
const T1 = `${TODAY}T11:00:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-darkspend-"));

  // Session A: 1M tokens, NO commits — pure dark spend. Two events 1
  // minute apart so active time is small but real (not zero).
  // Session B: 1M tokens, 1 commit with 200 LoC — efficient. Active span
  // is two events, plus a long gap that should be excluded as idle.
  // Session C: 500K tokens, 1 commit with 5 LoC — wasteful. Single event.
  const T0_PLUS_1MIN = `${TODAY}T09:01:00Z`;
  const T0_PLUS_2H = `${TODAY}T11:00:00Z`;          // outside 5-min idle window
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "a.jsonl"), [
    { id: "a1", timestamp: T0, agent: "claude_code", sessionId: "sess-a",
      project: "alpha", entryType: "message", role: "assistant",
      tokenUsage: { input: 200000, output: 50000, cacheRead: 750000, cacheCreation: 0 } },
    { id: "a2", timestamp: T0_PLUS_1MIN, agent: "claude_code", sessionId: "sess-a",
      project: "alpha", entryType: "tool_call", toolName: "Bash" },
  ]);
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "b.jsonl"), [
    { id: "b1", timestamp: T0, agent: "claude_code", sessionId: "sess-b",
      project: "beta", entryType: "message", role: "assistant",
      tokenUsage: { input: 200000, output: 50000, cacheRead: 750000, cacheCreation: 0 } },
    { id: "b2", timestamp: T0_PLUS_1MIN, agent: "claude_code", sessionId: "sess-b",
      project: "beta", entryType: "tool_call", toolName: "Bash" },
    // Big gap — should NOT count toward active time (two-hour pause).
    { id: "b3", timestamp: T0_PLUS_2H, agent: "claude_code", sessionId: "sess-b",
      project: "beta", entryType: "tool_call", toolName: "Bash" },
  ]);
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "c.jsonl"), [
    { id: "c1", timestamp: T0, agent: "claude_code", sessionId: "sess-c",
      project: "gamma", entryType: "message", role: "assistant",
      tokenUsage: { input: 100000, output: 20000, cacheRead: 380000, cacheCreation: 0 } },
  ]);

  // git events: B and C have commits; A has none.
  writeJsonl(join(DATA_DIR, TODAY, "git", "events.jsonl"), [
    { id: "g-b", timestamp: T1, eventType: "commit",
      project: "beta", repo: "owner/beta", branch: "main",
      commitSha: "bbbb", filesChanged: 4, insertions: 180, deletions: 20,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "feat", sessionId: "sess-b" },
    { id: "g-c", timestamp: T1, eventType: "commit",
      project: "gamma", repo: "owner/gamma", branch: "main",
      commitSha: "cccc", filesChanged: 1, insertions: 4, deletions: 1,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "tweak", sessionId: "sess-c" },
  ]);

  await initDb(DATA_DIR);
});

describe("getDarkSpend", () => {
  it("ranks sessions by tokens / max(LoC, 1) descending", async () => {
    const rows = await getDarkSpend({ days: 7 }, 50);
    expect(rows.length).toBe(3);

    // Session A: 0 commits, 0 LoC → ratio = tokens / 1 = 1M. Top of list.
    expect(rows[0]!.sessionId).toBe("sess-a");
    expect(rows[0]!.commits).toBe(0);
    expect(rows[0]!.locDelta).toBe(0);
    expect(rows[0]!.tokens).toBe(1_000_000);
    expect(rows[0]!.tokensPerLoc).toBe(1_000_000);
    // 1 minute between A's two events; everything within 5-min idle threshold.
    expect(rows[0]!.activeMs).toBe(60_000);

    // Session C: 500K / 5 = 100K. Second.
    expect(rows[1]!.sessionId).toBe("sess-c");
    expect(rows[1]!.commits).toBe(1);
    expect(rows[1]!.locDelta).toBe(5);   // 4 + 1
    expect(rows[1]!.tokensPerLoc).toBe(100_000);

    // Session B: 1M / 200 = 5K. Last (most efficient).
    expect(rows[2]!.sessionId).toBe("sess-b");
    expect(rows[2]!.commits).toBe(1);
    expect(rows[2]!.locDelta).toBe(200);  // 180 + 20
    expect(rows[2]!.tokensPerLoc).toBe(5_000);
    // 1 min between events 1-2, then a 119-min gap that should be excluded.
    // Active time should be just the 60 seconds, NOT the full ~2h wall.
    expect(rows[2]!.activeMs).toBe(60_000);
  });

  it("respects the limit argument", async () => {
    const rows = await getDarkSpend({ days: 7 }, 1);
    expect(rows.length).toBe(1);
  });
});
