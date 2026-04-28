import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import {
  getStats, getActivity, getHeatmap, getTokens, getTools,
  getProjects, getModels, getSessions, getProjectList, getModelList,
  getToolDetail, getSkills,
  getGitStats, getGitTimeline, getGitCommits, getGitSessions,
  getCommitDetail, getSessionCommits, getSessionSummary, getSessionDetail,
} from "../../server/queries";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const ONE_HOUR_AGO   = new Date(Date.now() - 1 * 3600_000).toISOString();
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 3600_000).toISOString();

let DATA_DIR: string;

beforeAll(async () => {
  // Bypass the dashboard's foreign-commit filter for these tests — they
  // use synthetic authors (Alice, Bob, etc.) that wouldn't match a real
  // developer email in config.yaml.
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-queries-"));

  // Today's claude_code traces — two sessions in project alpha, one in beta.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "session-1.jsonl"), [
    { id: "a1", timestamp: THREE_HOURS_AGO, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "Read",
      tokenUsage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0 } },
    { id: "a2", timestamp: THREE_HOURS_AGO, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "Edit",
      tokenUsage: { input: 200, output: 80 } },
    { id: "a3", timestamp: ONE_HOUR_AGO,   agent: "claude_code", sessionId: "s2",
      project: "beta",  entryType: "message",  role: "user",
      userPrompt: "/review this code please" },
    { id: "a4", timestamp: ONE_HOUR_AGO,   agent: "claude_code", sessionId: "s2",
      project: "beta",  entryType: "message",  role: "user",
      userPrompt: "/review fix the bug" },
    { id: "a5", timestamp: ONE_HOUR_AGO,   agent: "claude_code", sessionId: "s2",
      project: "beta",  entryType: "tool_call", toolName: "Read", model: "sonnet-4-7",
      tokenUsage: { input: 500, output: 200 } },
  ]);

  // Today's codex traces — same Read tool name, in alpha, different agent.
  writeJsonl(join(DATA_DIR, TODAY, "codex", "session-3.jsonl"), [
    { id: "c1", timestamp: ONE_HOUR_AGO, agent: "codex", sessionId: "s3",
      project: "alpha", entryType: "tool_call", toolName: "Read", model: "gpt-5",
      tokenUsage: { input: 80, output: 30 } },
  ]);

  // Today's git events.
  //   g1: agent-authored, sessionId already set (s1) — straight through
  //   g2: human commit, no session (and shouldn't get one)
  //   g3: agent-authored via Co-Authored-By (no sessionId on disk), in
  //       project beta at ONE_HOUR_AGO — falls inside session s2's window,
  //       so the dashboard's backfill should link it to s2 at ingest.
  writeJsonl(join(DATA_DIR, TODAY, "git", "events.jsonl"), [
    { id: "g1", timestamp: THREE_HOURS_AGO, eventType: "commit",
      project: "alpha", repo: "owner/alpha", branch: "main",
      commitSha: "deadbeef", filesChanged: 3, insertions: 100, deletions: 20,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "agent commit", sessionId: "s1" },
    // g2 is human-authored and timestamped THREE_HOURS_AGO in project
    // beta — there's no agent session in beta at that time, so backfill
    // must leave it unlinked.
    { id: "g2", timestamp: THREE_HOURS_AGO, eventType: "commit",
      project: "beta",  repo: "owner/beta",  branch: "main",
      commitSha: "cafebabe", filesChanged: 1, insertions: 10, deletions: 5,
      agentAuthored: false, author: "human@x.com", message: "human commit" },
    { id: "g3", timestamp: ONE_HOUR_AGO,   eventType: "commit",
      project: "beta",  repo: "owner/beta",  branch: "main",
      commitSha: "feedface", filesChanged: 2, insertions: 50, deletions: 10,
      agentAuthored: true, agentName: "claude_code",
      author: "agent@x.com", message: "co-authored agent commit" },
  ]);

  await initDb(DATA_DIR);
});

// ── Aggregates ─────────────────────────────────────────────────────

describe("getStats", () => {
  it("totals across all sources", async () => {
    const s = await getStats({ days: 7 });
    expect(s.total_entries).toBe(6);
    expect(s.total_sessions).toBe(3);
    expect(s.total_projects).toBe(2);
    expect(s.total_input_tokens).toBe(880);   // 100+200+500+80
    expect(s.total_output_tokens).toBe(360);
  });

  it("respects project filter", async () => {
    const s = await getStats({ days: 7, project: "alpha" });
    expect(s.total_entries).toBe(3);   // a1, a2, c1
    expect(s.total_sessions).toBe(2);  // s1, s3
  });
});

describe("getActivity", () => {
  it("groups by date+agent", async () => {
    const rows = await getActivity({ days: 7 });
    // Two agents on TODAY → 2 rows.
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.date === TODAY)).toBe(true);
    const claude = rows.find((r) => r.agent === "claude_code");
    const codex  = rows.find((r) => r.agent === "codex");
    expect(claude?.count).toBe(5);
    expect(codex?.count).toBe(1);
  });
});

describe("getTokens", () => {
  it("sums tokens per date", async () => {
    const rows = await getTokens({ days: 7 });
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(880);
    expect(rows[0].output_tokens).toBe(360);
  });
});

describe("getTools", () => {
  it("ranks tools by usage and includes primary_agent + agents list", async () => {
    const rows = await getTools({ days: 7 });
    const read = rows.find((r) => r.tool_name === "Read");
    const edit = rows.find((r) => r.tool_name === "Edit");
    expect(read).toBeDefined();
    expect(read!.count).toBe(3);          // a1 + a5 + c1
    expect(read!.primary_agent).toBe("claude_code"); // 2 from claude vs 1 from codex
    expect(read!.agents.sort()).toEqual(["claude_code", "codex"]);
    expect(edit?.count).toBe(1);
  });

  it("respects the limit", async () => {
    const rows = await getTools({ days: 7 }, 1);
    expect(rows.length).toBe(1);
  });
});

describe("getProjects", () => {
  it("returns per-project entry/session/token roll-ups", async () => {
    // alpha and beta both have 3 entries each; ordering is then arbitrary
    // (no secondary key), so assert by name rather than position.
    const rows = await getProjects({ days: 7 });
    expect(rows.length).toBe(2);
    const alpha = rows.find((r) => r.project === "alpha");
    const beta  = rows.find((r) => r.project === "beta");
    expect(alpha!.entries).toBe(3);
    expect(alpha!.sessions).toBe(2);
    expect(beta!.entries).toBe(3);
    expect(beta!.sessions).toBe(1);
  });
});

describe("getModels", () => {
  it("groups by model with token totals", async () => {
    const rows = await getModels({ days: 7 });
    const sonnet = rows.find((r) => r.model === "sonnet-4-7");
    const gpt5 = rows.find((r) => r.model === "gpt-5");
    expect(sonnet!.total_tokens).toBe(700);
    expect(gpt5!.total_tokens).toBe(110);
  });
});

describe("getSessions", () => {
  it("returns per-session aggregates ordered newest-first", async () => {
    const rows = await getSessions({ days: 7 });
    expect(rows.length).toBe(3);
    expect(rows[0].session_id).toBe("s2");  // most recent (started at 1h ago)
    expect(rows[0].entries).toBe(3);
  });

  it("filters to sessions containing a given tool", async () => {
    const rows = await getSessions({ days: 7, tool: "Edit" });
    expect(rows.length).toBe(1);
    expect(rows[0].session_id).toBe("s1");
  });
});

// ── Skills (slash commands) ────────────────────────────────────────

describe("getSkills", () => {
  it("counts user prompts that start with /<name>", async () => {
    const rows = await getSkills({ days: 7 });
    const review = rows.find((r) => r.skill === "/review");
    expect(review?.count).toBe(2);
  });
});

// ── Lookup lists ───────────────────────────────────────────────────

describe("getProjectList / getModelList", () => {
  it("returns distinct projects", async () => {
    expect((await getProjectList()).sort()).toEqual(["alpha", "beta"]);
  });
  it("returns distinct models", async () => {
    expect((await getModelList()).sort()).toEqual(["gpt-5", "sonnet-4-7"]);
  });
});

// ── Tool detail (drill-down) ───────────────────────────────────────

describe("getToolDetail", () => {
  it("aggregates timeline + per-agent + per-project for a tool", async () => {
    const d = await getToolDetail("Read", { days: 7 });
    expect(d.tool).toBe("Read");
    expect(d.total).toBe(3);
    expect(d.byAgent.find((a) => a.agent === "claude_code")?.count).toBe(2);
    expect(d.byAgent.find((a) => a.agent === "codex")?.count).toBe(1);
    expect(d.projects.length).toBeGreaterThan(0);
  });
});

// ── Git ─────────────────────────────────────────────────────────────

describe("git queries", () => {
  it("getGitStats: agent vs human split", async () => {
    const s = await getGitStats({ days: 7 });
    expect(s.total_commits).toBe(3);
    expect(s.agent_commits).toBe(2);  // g1 + g3 (g3 picked up by backfill)
    expect(s.human_commits).toBe(1);
    expect(s.total_insertions).toBe(160); // 100 + 10 + 50
    expect(s.agent_insertions).toBe(150);
    expect(s.repos).toBe(2);
  });

  it("getGitTimeline: rolls up per date with agent/human counters", async () => {
    const rows = await getGitTimeline({ days: 7 });
    expect(rows.length).toBe(1);
    expect(rows[0].agent_commits).toBe(2);
    expect(rows[0].human_commits).toBe(1);
  });

  it("getGitCommits: returns rows with boolean agent_authored + session_id", async () => {
    const rows = await getGitCommits({ days: 7 }, 5);
    expect(rows.length).toBe(3);
    const agent = rows.find((r) => r.commit_sha === "deadbeef")!;
    expect(agent.agent_authored).toBe(true);
    expect(typeof agent.agent_authored).toBe("boolean");
    expect(agent.session_id).toBe("s1");
    const human = rows.find((r) => r.commit_sha === "cafebabe")!;
    expect(human.agent_authored).toBe(false);
    expect(human.session_id).toBeNull();
  });

  it("getCommitDetail: single commit with parsed files array", async () => {
    const c = await getCommitDetail("deadbeef");
    expect(c).not.toBeNull();
    expect(c!.commit_sha).toBe("deadbeef");
    expect(c!.agent_authored).toBe(true);
    expect(c!.files).toEqual([]); // not provided in fixture
  });

  it("getCommitDetail: returns null for unknown sha", async () => {
    expect(await getCommitDetail("nope")).toBeNull();
  });
});

// ── Session detail / summary ───────────────────────────────────────

describe("getSessionSummary", () => {
  it("summarizes a session with token totals + tools + models", async () => {
    const s = await getSessionSummary("s1");
    expect(s).not.toBeNull();
    expect(s!.session_id).toBe("s1");
    expect(s!.entries).toBe(2);
    expect(s!.input_tokens).toBe(300);
    expect(s!.tools.find((t) => t.tool_name === "Read")?.count).toBe(1);
  });

  it("returns null for unknown session", async () => {
    expect(await getSessionSummary("nope")).toBeNull();
  });
});

describe("getSessionDetail", () => {
  it("returns entries, tool_summary, and linked commits", async () => {
    const d = await getSessionDetail("s1");
    expect(d).not.toBeNull();
    expect(d!.session_id).toBe("s1");
    expect(d!.entries.length).toBe(2);
    expect(d!.tool_summary.length).toBeGreaterThan(0);
    expect(d!.commits.length).toBe(1); // g1 is linked to s1
    expect(d!.commits[0].commit_sha).toBe("deadbeef");
    expect(d!.commits[0].agent_authored).toBe(true);
  });

  it("includes token totals (input/output/cache) for the session header", async () => {
    const d = await getSessionDetail("s1");
    expect(d!.input_tokens).toBe(300);   // a1 + a2 input
    expect(d!.output_tokens).toBe(130);  // a1 + a2 output
    expect(d!.cache_read).toBe(0);
    expect(d!.cache_creation).toBe(0);
  });

  it("computes active_ms + activity buckets from entry timestamps", async () => {
    const d = await getSessionDetail("s1");
    // s1's two entries share THREE_HOURS_AGO (zero-duration session). The
    // helper collapses that into a single activity bucket with the full
    // count and active_ms=0, instead of returning empty arrays which would
    // render as a hidden sparkline.
    expect(d!.active_ms).toBe(0);
    expect(d!.activity.length).toBeGreaterThanOrEqual(1);
    const totalCounts = d!.activity.reduce((s, b) => s + b.count, 0);
    expect(totalCounts).toBe(2);
  });
});

// ── Heatmap (date × project × agent) ───────────────────────────────

describe("getHeatmap", () => {
  it("groups by date, project, agent and excludes null projects", async () => {
    const rows = await getHeatmap({ days: 7 });
    // Three (date, project, agent) buckets should appear: claude/alpha,
    // claude/beta, codex/alpha.
    expect(rows.length).toBe(3);
    const claudeAlpha = rows.find((r) => r.project === "alpha" && r.agent === "claude_code");
    const claudeBeta  = rows.find((r) => r.project === "beta"  && r.agent === "claude_code");
    const codexAlpha  = rows.find((r) => r.project === "alpha" && r.agent === "codex");
    expect(claudeAlpha).toBeDefined();
    expect(claudeBeta).toBeDefined();
    expect(codexAlpha).toBeDefined();
    expect(claudeBeta!.total_tokens).toBeGreaterThan(0);
  });
});

// ── Commit ↔ session linkage ────────────────────────────────────────

describe("session ↔ commit linkage", () => {
  it("backfillCommitSessions: links Co-Authored-By commit to session window", async () => {
    // g3 was written without a sessionId but its timestamp falls in s2's
    // window — the dashboard's backfill runs at ingest and should fill it.
    const c = await getCommitDetail("feedface");
    expect(c).not.toBeNull();
    expect(c!.session_id).toBe("s2");
    expect(c!.agent_authored).toBe(true);
  });

  it("backfillCommitSessions: leaves explicit sessionId alone", async () => {
    // g1 already had sessionId=s1 on disk. Backfill shouldn't touch it
    // (and shouldn't move it to s3, even though s3 is in alpha at a
    // similar time).
    const c = await getCommitDetail("deadbeef");
    expect(c!.session_id).toBe("s1");
  });

  it("backfillCommitSessions: doesn't link human commits", async () => {
    // g2 is human-authored and outside any agent session window. It must
    // stay unlinked — backfill is *only* for missing sessionIds, not
    // for re-attributing humans.
    const c = await getCommitDetail("cafebabe");
    expect(c!.session_id).toBeNull();
    expect(c!.agent_authored).toBe(false);
  });

  it("getSessionCommits: returns siblings ordered by timestamp asc", async () => {
    const commits = await getSessionCommits("s2");
    expect(commits.length).toBe(1);   // only g3 lives in s2 (after backfill)
    expect(commits[0].commit_sha).toBe("feedface");
    expect(commits[0].session_id).toBe("s2");
  });

  it("getSessionCommits: empty for unknown session", async () => {
    expect(await getSessionCommits("nope")).toEqual([]);
  });
});

// ── "By session" view (sessions that produced commits) ─────────────

describe("getGitSessions", () => {
  it("returns one row per session that produced commits, with totals + commits[]", async () => {
    const sessions = await getGitSessions({ days: 7 });
    // s1 (deadbeef) and s2 (feedface) produced commits; s3 didn't.
    expect(sessions.length).toBe(2);
    const ids = sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(["s1", "s2"]);
    const s1 = sessions.find((s) => s.session_id === "s1")!;
    expect(s1.agent).toBe("claude_code");
    expect(s1.commits.length).toBe(1);
    expect(s1.commits[0].commit_sha).toBe("deadbeef");
    expect(s1.input_tokens).toBe(300);
    expect(s1.entries).toBe(2);
  });

  it("respects project filter", async () => {
    const sessions = await getGitSessions({ days: 7, project: "beta" });
    expect(sessions.length).toBe(1);
    expect(sessions[0].session_id).toBe("s2");
  });
});
