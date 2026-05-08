import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getGitStats, getCommitAttributionByProject, getUnlinkedAgentCommits } from "../../server/queries";

/**
 * "Commit attribution health" surfaces how many agent-authored commits
 * actually link back to a session. In real data ~60% of agent commits
 * never get a sessionId (the backfill misses them when no concurrent
 * agent session covers the commit's timestamp window). Every
 * downstream session metric — zero-code, dark-spend, productivity
 * score — divides by linked agent commits, so without surfacing the
 * gap those numbers silently undercount.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = `${TODAY}T10:00:00Z`;
const T_OLD = `${TODAY}T01:00:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-attribution-"));

  // One claude_code session in alpha — covers the linked agent commit.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s1.jsonl"), [
    { id: "a1", timestamp: T, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "Edit",
      tokenUsage: { input: 10, output: 5 } },
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "git", "events.jsonl"), [
    // Linked agent commit: sessionId set on disk, in alpha at T.
    { id: "g1", timestamp: T, eventType: "commit",
      project: "alpha", repo: "owner/alpha", branch: "main",
      commitSha: "deadbeef", filesChanged: 1, insertions: 10, deletions: 0,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "linked agent commit", sessionId: "s1" },
    // Unlinked agent commit: project ghost has no sessions at all, so
    // the backfill can't recover it. This is the case we need to flag.
    { id: "g2", timestamp: T_OLD, eventType: "commit",
      project: "ghost", repo: "owner/ghost", branch: "main",
      commitSha: "cafebabe", filesChanged: 1, insertions: 5, deletions: 0,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "orphan agent commit" },
    // Human commit in a session-less project — irrelevant for
    // attribution but should not skew the count. Note: the dashboard's
    // session backfill at db.ts:444 will mis-promote any orphan
    // human commit to agentAuthored=1 if it falls in an active
    // session's project+window. That's a separate known issue
    // (improvements.md item #1 calls it out as one of the heuristics
    // to revisit). To keep this test focused on the attribution
    // counters and not co-investigate that bug, the human commit
    // here lives in the same session-less `ghost` project so the
    // backfill skips it.
    { id: "g3", timestamp: T, eventType: "commit",
      project: "ghost", repo: "owner/ghost", branch: "main",
      commitSha: "feedface", filesChanged: 1, insertions: 1, deletions: 0,
      agentAuthored: false,
      author: "human@x.com", message: "human commit" },
  ]);

  await initDb(DATA_DIR);
});

describe("getGitStats commit attribution", () => {
  it("counts linked agent commits (sessionId set)", async () => {
    const s = await getGitStats({ days: 1 });
    expect(s.linked_agent_commits).toBe(1);
  });

  it("counts unlinked agent commits (sessionId null)", async () => {
    const s = await getGitStats({ days: 1 });
    expect(s.unlinked_agent_commits).toBe(1);
  });

  it("linked + unlinked sums to agent_commits", async () => {
    // Invariant the dashboard depends on: the two new fields partition
    // agent_commits cleanly; nothing falls through the cracks.
    const s = await getGitStats({ days: 1 });
    expect(s.linked_agent_commits + s.unlinked_agent_commits).toBe(s.agent_commits);
  });

  it("ignores human commits in both new counters", async () => {
    const s = await getGitStats({ days: 1 });
    expect(s.agent_commits).toBe(2);
    expect(s.human_commits).toBe(1);
    // Human commits sit outside the agent partition.
    expect(s.linked_agent_commits + s.unlinked_agent_commits).not.toBe(s.total_commits);
  });

  it("respects project filter", async () => {
    // Filtering to ghost: orphan agent commit + the human commit.
    // The new counters only see the agent one and report it as unlinked.
    const s = await getGitStats({ days: 1, project: "ghost" });
    expect(s.agent_commits).toBe(1);
    expect(s.human_commits).toBe(1);
    expect(s.linked_agent_commits).toBe(0);
    expect(s.unlinked_agent_commits).toBe(1);
  });
});

describe("getCommitAttributionByProject", () => {
  it("returns one row per project that has at least one agent commit", async () => {
    const rows = await getCommitAttributionByProject({ days: 1 });
    const projects = rows.map((r) => r.project).sort();
    // alpha (1 linked) + ghost (1 unlinked). No row for projects with
    // only human commits (none in this fixture, but the contract).
    expect(projects).toEqual(["alpha", "ghost"]);
  });

  it("partitions agent_commits into linked + unlinked per project", async () => {
    const rows = await getCommitAttributionByProject({ days: 1 });
    const alpha = rows.find((r) => r.project === "alpha")!;
    expect(alpha.agent_commits).toBe(1);
    expect(alpha.linked_agent_commits).toBe(1);
    expect(alpha.unlinked_agent_commits).toBe(0);
    const ghost = rows.find((r) => r.project === "ghost")!;
    expect(ghost.agent_commits).toBe(1);
    expect(ghost.linked_agent_commits).toBe(0);
    expect(ghost.unlinked_agent_commits).toBe(1);
  });

  it("orders worst-attributed projects first (unlinked desc, then total desc)", async () => {
    // ghost has 1 unlinked, alpha has 0 — ghost should sort first.
    const rows = await getCommitAttributionByProject({ days: 1 });
    expect(rows[0]!.project).toBe("ghost");
  });

  it("ignores human-only projects (returns no row when no agent commits)", async () => {
    // The fixture has no human-only project. To test the contract,
    // filter to a name that doesn't exist — the query should return
    // an empty array, not a row with zeros.
    const rows = await getCommitAttributionByProject({ days: 1, project: "does-not-exist" });
    expect(rows).toEqual([]);
  });
});

describe("getUnlinkedAgentCommits (drill-down)", () => {
  it("returns the orphan agent commits in a project, newest first", async () => {
    // ghost has exactly one orphan agent commit (g2). The drill-down
    // should return it with the same shape as the existing
    // GitCommitRow query, so the UI can reuse the formatting.
    const rows = await getUnlinkedAgentCommits("ghost", { days: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.commit_sha).toBe("cafebabe");
    expect(rows[0]!.agent_authored).toBe(true);
    expect(rows[0]!.session_id).toBeNull();
  });

  it("does NOT return linked agent commits", async () => {
    // alpha has only g1 (linked). Drill-down should be empty.
    const rows = await getUnlinkedAgentCommits("alpha", { days: 1 });
    expect(rows).toEqual([]);
  });

  it("does NOT return human commits, even when they share the project", async () => {
    // ghost has both g2 (orphan agent) and g3 (human in same project).
    // Drill-down sees only the agent one — the human commit is not
    // an attribution gap.
    const rows = await getUnlinkedAgentCommits("ghost", { days: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0]!.author).toBe("agent@x.com");
  });

  it("returns an empty array for an unknown project", async () => {
    const rows = await getUnlinkedAgentCommits("does-not-exist", { days: 1 });
    expect(rows).toEqual([]);
  });
});
