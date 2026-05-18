import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getComparison, getComparisonTimeline } from "../../server/queries";

/**
 * `getComparison({ cutoff, repos? })` splits git history at a user-
 * provided cutoff date and returns the same set of metrics computed
 * over each window. Post-cutoff also splits human-authored vs
 * agent-authored. The cutoff is intended to be the user's first
 * observer-collected commit, so they can compare "pre AI tooling"
 * against "post AI tooling" on the same repos.
 *
 * Returned metrics, per bucket (pre / post / postHuman / postAgent):
 *   - commits, activeDays
 *   - commitsPerActiveDay
 *   - medianLocDelta, meanLocDelta
 *   - medianFiles, meanFiles
 *   - testCommitPct (commits whose files include a test path)
 *   - bigCommitPct (LoC delta > 500)
 *   - smallCommitPct (LoC delta < 50)
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const CUTOFF = "2026-02-01";

function commitRow(opts: {
  id: string;
  shipDate: string;
  ts: string;
  project: string;
  insertions: number;
  deletions: number;
  files: string[];
  agentAuthored?: boolean;
}): Record<string, unknown> {
  return {
    id: opts.id,
    timestamp: opts.ts,
    eventType: "commit",
    project: opts.project,
    repo: `owner/${opts.project}`,
    branch: "main",
    commitSha: opts.id,
    filesChanged: opts.files.length,
    insertions: opts.insertions,
    deletions: opts.deletions,
    agentAuthored: !!opts.agentAuthored,
    agentName: opts.agentAuthored ? "claude_code" : null,
    author: "test@example.com",
    authorEmail: "test@example.com",
    message: "fix",
    files: opts.files,
  };
}

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-comparison-"));

  // PRE-period: 3 commits on alpha, 2 calendar days, very few tests.
  writeJsonl(join(dataDir, "2026-01-10", "git", "alpha.jsonl"), [
    commitRow({
      id: "pre1", shipDate: "2026-01-10", ts: "2026-01-10T10:00:00Z",
      project: "alpha", insertions: 20, deletions: 5,
      files: ["src/a.ts", "src/b.ts"],
    }),
    commitRow({
      id: "pre2", shipDate: "2026-01-10", ts: "2026-01-10T11:00:00Z",
      project: "alpha", insertions: 600, deletions: 0,
      files: ["src/big.ts"],
    }),
  ]);
  writeJsonl(join(dataDir, "2026-01-15", "git", "alpha.jsonl"), [
    commitRow({
      id: "pre3", shipDate: "2026-01-15", ts: "2026-01-15T10:00:00Z",
      project: "alpha", insertions: 30, deletions: 0,
      files: ["src/c.ts"],
    }),
  ]);

  // POST-period: 4 commits on alpha — 2 human, 2 agent. More tests.
  writeJsonl(join(dataDir, "2026-03-01", "git", "alpha.jsonl"), [
    commitRow({
      id: "post-h1", shipDate: "2026-03-01", ts: "2026-03-01T10:00:00Z",
      project: "alpha", insertions: 40, deletions: 10,
      files: ["src/d.ts", "tests/d.test.ts"],
    }),
    commitRow({
      id: "post-h2", shipDate: "2026-03-01", ts: "2026-03-01T12:00:00Z",
      project: "alpha", insertions: 5, deletions: 5,
      files: ["src/tiny.ts"],
    }),
  ]);
  writeJsonl(join(dataDir, "2026-03-05", "git", "alpha.jsonl"), [
    commitRow({
      id: "post-a1", shipDate: "2026-03-05", ts: "2026-03-05T14:00:00Z",
      project: "alpha", insertions: 80, deletions: 20,
      files: ["src/e.ts", "tests/e.test.ts", "tests/helpers.ts"],
      agentAuthored: true,
    }),
    commitRow({
      id: "post-a2", shipDate: "2026-03-05", ts: "2026-03-05T16:00:00Z",
      project: "alpha", insertions: 700, deletions: 100,
      files: ["src/bigfeat.ts", "tests/bigfeat.test.ts"],
      agentAuthored: true,
    }),
  ]);

  // POST-period on a different repo (beta) — used to test the repo
  // filter (default is "repos active in both windows" so beta should
  // be excluded when that filter is on).
  writeJsonl(join(dataDir, "2026-03-10", "git", "beta.jsonl"), [
    commitRow({
      id: "post-beta", shipDate: "2026-03-10", ts: "2026-03-10T10:00:00Z",
      project: "beta", insertions: 10, deletions: 0,
      files: ["src/x.ts"],
    }),
  ]);

  await initDb(dataDir);
});

describe("getComparison", () => {
  it("splits at the cutoff and reports commit counts per bucket", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    expect(c.pre.commits).toBe(3);
    expect(c.post.commits).toBe(5); // 4 alpha + 1 beta
    expect(c.postHuman.commits).toBe(3); // 2 alpha + 1 beta
    expect(c.postAgent.commits).toBe(2);
  });

  it("reports active-day counts and the derived commits-per-active-day rate", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    expect(c.pre.activeDays).toBe(2); // 2026-01-10, 2026-01-15
    expect(c.post.activeDays).toBe(3); // 03-01, 03-05, 03-10
    expect(c.pre.commitsPerActiveDay).toBeCloseTo(1.5, 1);
    expect(c.post.commitsPerActiveDay).toBeCloseTo(5 / 3, 1);
  });

  it("reports median + mean LoC delta", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    // pre: deltas = [25, 600, 30] → sorted [25,30,600] → median 30
    expect(c.pre.medianLocDelta).toBe(30);
    expect(c.pre.meanLocDelta).toBeCloseTo((25 + 600 + 30) / 3, 0);
    // postAgent: deltas = [100, 800] → median 450
    expect(c.postAgent.medianLocDelta).toBe(450);
  });

  it("reports % of commits that touched a test file", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    expect(c.pre.testCommitPct).toBe(0);
    // post: 3 of 5 (post-h1, post-a1, post-a2) touched a test path
    expect(c.post.testCommitPct).toBeCloseTo(60, 0);
    // postAgent: 2 of 2 touched tests
    expect(c.postAgent.testCommitPct).toBe(100);
  });

  it("reports the big/small-commit distribution", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    // pre: 1 of 3 commits > 500 LoC (pre2) → 33%; 2 of 3 < 50 LoC → 67%
    expect(c.pre.bigCommitPct).toBeCloseTo(33, 0);
    expect(c.pre.smallCommitPct).toBeCloseTo(67, 0);
  });

  it("repos-in-both filter narrows post to repos that also had pre activity", async () => {
    const c = await getComparison({ cutoff: CUTOFF, sameReposOnly: true });
    // beta is post-only → its commit drops out of post when this filter is on.
    expect(c.post.commits).toBe(4);
    expect(c.postHuman.commits).toBe(2);
    expect(c.postAgent.commits).toBe(2);
  });

  it("returns the list of repos active in each window so the UI can show it", async () => {
    const c = await getComparison({ cutoff: CUTOFF });
    expect(c.preRepos.sort()).toEqual(["alpha"]);
    expect(c.postRepos.sort()).toEqual(["alpha", "beta"]);
    expect(c.bothWindowRepos.sort()).toEqual(["alpha"]);
  });
});

describe("getComparisonTimeline", () => {
  // The timeline endpoint returns one slim row per commit so the
  // client can drag a cutoff slider and recompute buckets locally
  // without round-tripping. We pre-compute `hasTest` server-side so
  // the rows don't have to carry the `files` array.

  it("returns one row per commit, with the trimmed shape", async () => {
    const t = await getComparisonTimeline();
    // Fixture: 3 pre alpha + 4 post alpha + 1 post beta = 8.
    expect(t.commits.length).toBe(8);
    for (const c of t.commits) {
      expect(typeof c.ts).toBe("string");
      expect(typeof c.project).toBe("string");
      expect(typeof c.locDelta).toBe("number");
      expect(typeof c.hasTest).toBe("boolean");
      expect(typeof c.agent).toBe("boolean");
      // Body fields should NOT leak through.
      expect(c).not.toHaveProperty("files");
      expect(c).not.toHaveProperty("message");
    }
  });

  it("flags agentAuthored commits", async () => {
    const t = await getComparisonTimeline();
    const agentCount = t.commits.filter((c) => c.agent).length;
    expect(agentCount).toBe(2); // post-a1 + post-a2
  });

  it("flags hasTest based on file paths in the original git_events", async () => {
    const t = await getComparisonTimeline();
    const withTests = t.commits.filter((c) => c.hasTest).length;
    expect(withTests).toBe(3); // post-h1, post-a1, post-a2
  });

  it("reports earliest and latest timestamps so the UI can scale the slider", async () => {
    const t = await getComparisonTimeline();
    expect(t.earliest.slice(0, 10)).toBe("2026-01-10");
    expect(t.latest.slice(0, 10)).toBe("2026-03-10");
  });

  it("reports firstAgentCommitDate so the UI can plant the fixed marker", async () => {
    const t = await getComparisonTimeline();
    expect(t.firstAgentCommitDate).toBe("2026-03-05");
  });

  it("respects the project filter", async () => {
    const t = await getComparisonTimeline({ project: "alpha" });
    expect(t.commits.length).toBe(7); // 3 pre + 4 post alpha; beta dropped
    expect(new Set(t.commits.map((c) => c.project))).toEqual(new Set(["alpha"]));
  });

  it("respects the agent filter — keeps human commits, restricts agent commits to the chosen name", async () => {
    // The fixture tags agent commits with agentName=claude_code. Filtering
    // by agent=claude_code should leave the human commits intact (so PRE
    // is unaffected) while restricting agent-side commits to claude_code.
    const t = await getComparisonTimeline({ agent: "claude_code" });
    expect(t.commits.length).toBe(8); // all kept — fixture has only one agent
    const t2 = await getComparisonTimeline({ agent: "codex" });
    // No codex commits in fixture, so agent rows drop, human rows stay.
    expect(t2.commits.filter((c) => c.agent).length).toBe(0);
    expect(t2.commits.filter((c) => !c.agent).length).toBe(6);
  });
});
