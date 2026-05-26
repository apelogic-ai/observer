import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getDarkSpend, getZeroCode } from "../../server/queries";

/**
 * Defense-in-depth for the human-commit promotion bug fixed in the
 * ingest backfill. Even if a human commit ends up linked to a
 * session through some other path (e.g. an older trace where the
 * human shared their session id, or future bug regression), the
 * session rollup that powers dark-spend / zero-code must not credit
 * its LoC. Those metrics are about agent productivity; counting
 * human work flatters every ratio and undercounts dark spend.
 *
 * Lives in its own file so the global initDb singleton in db.ts
 * doesn't bleed across test files.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = `${TODAY}T09:00:00Z`;
const T1 = `${TODAY}T11:00:00Z`;

beforeAll(async () => {
  process.env.OBSERVER_TEST_ALLOW_FOREIGN_FILTER_BYPASS = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-rollup-attr-"));
  writeJsonl(join(dataDir, TODAY, "claude_code", "z.jsonl"), [
    { id: "z1", timestamp: T0, agent: "claude_code", sessionId: "sess-z",
      project: "alpha", entryType: "message", role: "assistant",
      tokenUsage: { input: 100000, output: 20000, cacheRead: 380000, cacheCreation: 0 } },
  ]);
  // Two commits both linked to sess-z: one agent (10 LoC), one
  // human (1000 LoC). Only the agent commit should count toward
  // session metrics — locDelta should be 10, not 1010.
  writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
    { id: "g-agent", timestamp: T1, eventType: "commit",
      project: "alpha", repo: "owner/alpha", branch: "main",
      commitSha: "aaaa", filesChanged: 1, insertions: 10, deletions: 0,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "agent fix", sessionId: "sess-z" },
    { id: "g-human", timestamp: T1, eventType: "commit",
      project: "alpha", repo: "owner/alpha", branch: "main",
      commitSha: "hhhh", filesChanged: 5, insertions: 800, deletions: 200,
      agentAuthored: false,
      author: "human@x.com", message: "human refactor", sessionId: "sess-z" },
  ]);
  await initDb(dataDir);
});

describe("session rollups: only agent commits count", () => {
  it("dark-spend reports agent-only commit count + LoC for the session", async () => {
    const rows = await getDarkSpend({ days: 1 });
    const z = rows.find((r) => r.sessionId === "sess-z");
    expect(z).toBeDefined();
    // 1 agent commit, 10 LoC — NOT 2 commits / 1010 LoC even though
    // both rows in git_events list sess-z as their session id.
    expect(z!.commits).toBe(1);
    expect(z!.locDelta).toBe(10);
  });

  it("zero-code does NOT include the session — its agent LoC is 10, not 0", async () => {
    const rows = await getZeroCode({ days: 1 });
    expect(rows.find((r) => r.sessionId === "sess-z")).toBeUndefined();
  });
});
