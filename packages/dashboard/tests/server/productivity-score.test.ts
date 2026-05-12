import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getProductivityScore } from "../../server/queries";

/**
 * `getProductivityScore(filters)` composes items #1-#7 into a
 * per-session row of red/green quality flags + a bucket label.
 * Bucketing semantics (locked in below):
 *
 *   - productive               — shipped a commit AND ≤2 red flags,
 *                                 ideally validatedAfterEdit
 *   - expensive-but-productive — shipped a commit BUT ≥3 red flags
 *                                 OR very high tokens/LoC
 *   - stuck                    — no commit AND (stuck-test loop OR
 *                                 high failure rate)
 *   - needs-better-setup       — no commit AND no stuck loops, but
 *                                 ≥2 red flags (intervention,
 *                                 search/edit, latency)
 *   - exploration              — no edits at all; out of scope for
 *                                 quality measurement
 *
 * Sessions are returned only if they touched code (edit-shaped tool
 * call) OR committed. Pure-chat is filtered out.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = (h: number, m = 0) => `${TODAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-productivity-"));

  // Session A — productive: 1 user turn, an edit, a passing test,
  // an agent commit linked to the session. Should land in the
  // "productive" bucket.
  writeJsonl(join(dataDir, TODAY, "claude_code", "good.jsonl"), [
    { id: "g-msg", timestamp: T(9, 0), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "message", role: "user", userPrompt: "fix the bug",
      tokenUsage: { input: 5000, output: 1000, cacheRead: 50000, cacheCreation: 0 } },
    { id: "g-edit", timestamp: T(9, 5), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/a.ts" },
    { id: "g-test-call", timestamp: T(9, 10), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", toolCallId: "g-call", command: "bun test" },
    { id: "g-test-result", timestamp: T(9, 11), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "tool_result", role: "tool",
      toolName: "Bash", toolCallId: "g-call", success: true },
  ]);
  writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
    { id: "g-commit", timestamp: T(9, 15), eventType: "commit",
      project: "alpha", repo: "owner/alpha", branch: "main",
      commitSha: "deadbeef", filesChanged: 1, insertions: 20, deletions: 0,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "fix", sessionId: "good" },
  ]);

  // Session B — stuck: edits + 3 failing test runs, no commit.
  writeJsonl(join(dataDir, TODAY, "claude_code", "stuck.jsonl"), [
    { id: "s-msg", timestamp: T(10, 0), agent: "claude_code", sessionId: "stuck",
      project: "beta", entryType: "message", role: "user", userPrompt: "fix tests",
      tokenUsage: { input: 200000, output: 50000, cacheRead: 5000000, cacheCreation: 0 } },
    { id: "s-edit", timestamp: T(10, 5), agent: "claude_code", sessionId: "stuck",
      project: "beta", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/b.ts" },
    // Three failing runs of the same test — triggers stuck-loop detector.
    ...Array.from({ length: 3 }, (_, i) => ([
      { id: `s-c-${i}`, timestamp: T(10, 10 + i * 2), agent: "claude_code", sessionId: "stuck",
        project: "beta", entryType: "tool_call", role: "assistant",
        toolName: "Bash", toolCallId: `s-call-${i}`, command: "bun test src/b.test.ts" },
      { id: `s-r-${i}`, timestamp: T(10, 11 + i * 2), agent: "claude_code", sessionId: "stuck",
        project: "beta", entryType: "tool_result", role: "tool",
        toolName: "Bash", toolCallId: `s-call-${i}`, success: false },
    ])).flat(),
  ]);

  // Session C — needs-better-setup: edited, lots of grep/read, no
  // commit, no stuck loops. High navigation friction signature.
  writeJsonl(join(dataDir, TODAY, "claude_code", "thrash.jsonl"), [
    { id: "t-msg", timestamp: T(11, 0), agent: "claude_code", sessionId: "thrash",
      project: "gamma", entryType: "message", role: "user", userPrompt: "where is foo",
      tokenUsage: { input: 100000, output: 20000, cacheRead: 1000000, cacheCreation: 0 } },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `t-r-${i}`, timestamp: T(11, 1 + i), agent: "claude_code", sessionId: "thrash",
      project: "gamma", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "grep -r foo .",
    })),
    { id: "t-edit", timestamp: T(11, 35), agent: "claude_code", sessionId: "thrash",
      project: "gamma", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/c.ts" },
  ]);

  // Session D — exploration: read-only, no edits. Should NOT appear.
  writeJsonl(join(dataDir, TODAY, "claude_code", "explore.jsonl"), [
    { id: "x-msg", timestamp: T(12, 0), agent: "claude_code", sessionId: "explore",
      project: "alpha", entryType: "message", role: "user", userPrompt: "look around" },
    { id: "x-r", timestamp: T(12, 1), agent: "claude_code", sessionId: "explore",
      project: "alpha", entryType: "tool_call", role: "assistant", toolName: "Read", filePath: "README.md" },
  ]);

  await initDb(dataDir);
});

describe("getProductivityScore", () => {
  it("classifies a session that shipped a commit + validation as productive", async () => {
    const rows = await getProductivityScore({ days: 1 });
    const good = rows.find((r) => r.sessionId === "good");
    expect(good).toBeDefined();
    expect(good!.bucket).toBe("productive");
    expect(good!.commits).toBe(1);
    expect(good!.validatedAfterEdit).toBe(true);
    expect(good!.greenFlags).toContain("shipped-commit");
    expect(good!.greenFlags).toContain("validated");
  });

  it("classifies a session with stuck-test loops and no commit as stuck", async () => {
    const rows = await getProductivityScore({ days: 1 });
    const stuck = rows.find((r) => r.sessionId === "stuck");
    expect(stuck).toBeDefined();
    expect(stuck!.bucket).toBe("stuck");
    expect(stuck!.stuckLoops).toBeGreaterThanOrEqual(1);
    expect(stuck!.redFlags).toContain("stuck-loops");
  });

  it("classifies a session with high navigation friction and no commit as needs-better-setup", async () => {
    const rows = await getProductivityScore({ days: 1 });
    const thrash = rows.find((r) => r.sessionId === "thrash");
    expect(thrash).toBeDefined();
    expect(thrash!.bucket).toBe("needs-better-setup");
    expect(thrash!.redFlags).toContain("high-search-ratio");
  });

  it("excludes pure-chat / read-only sessions (no edit, no commit)", async () => {
    const rows = await getProductivityScore({ days: 1 });
    expect(rows.find((r) => r.sessionId === "explore")).toBeUndefined();
  });

  it("reports the underlying inputs alongside flags", async () => {
    const rows = await getProductivityScore({ days: 1 });
    const good = rows.find((r) => r.sessionId === "good")!;
    expect(typeof good.tokens).toBe("number");
    expect(typeof good.userTurns).toBe("number");
    expect(typeof good.locDelta).toBe("number");
  });

  it("respects project + agent filters", async () => {
    const beta = await getProductivityScore({ days: 1, project: "beta" });
    expect(beta.map((r) => r.sessionId)).toEqual(["stuck"]);
  });

  it("assigns a numeric score 0-100 that orders within and across buckets", async () => {
    const rows = await getProductivityScore({ days: 1 });
    const good = rows.find((r) => r.sessionId === "good")!;
    const stuck = rows.find((r) => r.sessionId === "stuck")!;
    const thrash = rows.find((r) => r.sessionId === "thrash")!;

    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
    // Shipping + validating is the clearest "good" signal — it
    // must outrank the no-commit cases. Whether stuck or thrash is
    // worse is subjective (the bucket label is the headline; the
    // score is a within-bucket tiebreaker), so we don't compare
    // them directly here.
    expect(good.score).toBeGreaterThan(thrash.score);
    expect(good.score).toBeGreaterThan(stuck.score);
  });
});
