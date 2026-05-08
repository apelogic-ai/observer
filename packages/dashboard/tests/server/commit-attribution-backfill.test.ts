import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getGitStats } from "../../server/queries";

/**
 * The first-pass session-attribution backfill in db.ts requires
 * `session.project === commit.project`. That misses the real case
 * surfaced by the live dashboard: Claude Code launched from cwd
 * `db-mcp` (so session project=db-mcp) calls a tool that shells into
 * the boost-dbt repo and commits there. The commit has
 * `agentName="claude_code"` and sits inside the session's timestamp
 * window, but the project labels disagree — so the project-equality
 * pass leaves it orphan.
 *
 * Fallback we add: for orphans surviving the project pass, try
 * matching by `agentName` only — if exactly one session of that
 * agent covers the commit's timestamp window, link them. Multiple
 * matches stay orphan (we don't guess between concurrent sessions).
 *
 * Each test sits in its own file with its own initDb so the global
 * SQLite singleton in db.ts can't bleed across cases.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T_COMMIT = `${TODAY}T01:00:00Z`;
const T_SESSION_START = `${TODAY}T00:30:00Z`;
const T_SESSION_END = `${TODAY}T01:30:00Z`;

describe("backfill: cross-project agent-name fallback", () => {
  it("links via agentName + time window when no project-matching session covers the commit", async () => {
    process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
    const dataDir = mkdtempSync(join(tmpdir(), "observer-attr-fallback-"));
    // claude_code session in alpha covering T_COMMIT.
    writeJsonl(join(dataDir, TODAY, "claude_code", "s_cross.jsonl"), [
      { id: "x1", timestamp: T_SESSION_START, agent: "claude_code",
        sessionId: "s_cross", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
      { id: "x2", timestamp: T_SESSION_END, agent: "claude_code",
        sessionId: "s_cross", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
    ]);
    // Orphan agent commit in a DIFFERENT project (ghost) at T_COMMIT.
    writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
      { id: "g_orphan", timestamp: T_COMMIT, eventType: "commit",
        project: "ghost", repo: "owner/ghost", branch: "main",
        commitSha: "deadbeef", filesChanged: 1, insertions: 5, deletions: 0,
        agentAuthored: true, agentName: "claude_code",
        author: "agent@x.com", message: "orphan agent commit" },
    ]);
    await initDb(dataDir);

    const s = await getGitStats({ days: 1 });
    expect(s.linked_agent_commits).toBe(1);
    expect(s.unlinked_agent_commits).toBe(0);
  });
});

describe("backfill: ambiguous fallback stays orphan", () => {
  it("does NOT link when multiple sessions of the same agent cover the window", async () => {
    process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
    const dataDir = mkdtempSync(join(tmpdir(), "observer-attr-ambig-"));
    // Two concurrent claude_code sessions, different projects.
    writeJsonl(join(dataDir, TODAY, "claude_code", "s_a.jsonl"), [
      { id: "a1", timestamp: T_SESSION_START, agent: "claude_code",
        sessionId: "s_a", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
      { id: "a2", timestamp: T_SESSION_END, agent: "claude_code",
        sessionId: "s_a", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
    ]);
    writeJsonl(join(dataDir, TODAY, "claude_code", "s_b.jsonl"), [
      { id: "b1", timestamp: T_SESSION_START, agent: "claude_code",
        sessionId: "s_b", project: "beta", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
      { id: "b2", timestamp: T_SESSION_END, agent: "claude_code",
        sessionId: "s_b", project: "beta", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
    ]);
    writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
      { id: "g_orphan", timestamp: T_COMMIT, eventType: "commit",
        project: "ghost", repo: "owner/ghost", branch: "main",
        commitSha: "deadbeef", filesChanged: 1, insertions: 5, deletions: 0,
        agentAuthored: true, agentName: "claude_code",
        author: "agent@x.com", message: "orphan agent commit" },
    ]);
    await initDb(dataDir);

    const s = await getGitStats({ days: 1 });
    expect(s.unlinked_agent_commits).toBe(1);
    expect(s.linked_agent_commits).toBe(0);
  });
});

describe("backfill: tight activity window, not session bounds", () => {
  it("treats a long-running session with no nearby activity as NOT a match", async () => {
    // Real shape from the live dashboard: a long-running Claude Code
    // conversation has its first tool_call far before the commit and
    // its last tool_call far after, so session-bounds matching would
    // include it as a candidate. But it has no actual activity near
    // the commit timestamp — the agent did other work, then sat
    // idle. The fallback must use proximity to actual tool_calls,
    // not the outer [start, end] envelope, otherwise long sessions
    // shadow the real culprit and we get ambiguous (or wrong) links.
    process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
    const dataDir = mkdtempSync(join(tmpdir(), "observer-attr-tightwin-"));
    // Long-running session with activity FAR from the commit (2h+).
    // Bounds = [TODAY 00:30, TODAY 23:30] — would cover T_COMMIT.
    writeJsonl(join(dataDir, TODAY, "claude_code", "s_long.jsonl"), [
      { id: "long1", timestamp: `${TODAY}T00:30:00Z`, agent: "claude_code",
        sessionId: "s_long", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
      { id: "long2", timestamp: `${TODAY}T23:30:00Z`, agent: "claude_code",
        sessionId: "s_long", project: "alpha", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
    ]);
    // Short session with activity right around the commit time.
    writeJsonl(join(dataDir, TODAY, "claude_code", "s_short.jsonl"), [
      { id: "short1", timestamp: `${TODAY}T00:50:00Z`, agent: "claude_code",
        sessionId: "s_short", project: "beta", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
      { id: "short2", timestamp: `${TODAY}T01:10:00Z`, agent: "claude_code",
        sessionId: "s_short", project: "beta", entryType: "tool_call",
        toolName: "Bash", tokenUsage: { input: 10, output: 5 } },
    ]);
    writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
      // Commit at T_COMMIT (01:00). s_short has activity at 00:50
      // and 01:10 — both within ±30min. s_long's nearest activity
      // is 23h away. Only s_short should qualify.
      { id: "g_orphan", timestamp: T_COMMIT, eventType: "commit",
        project: "ghost", repo: "owner/ghost", branch: "main",
        commitSha: "deadbeef", filesChanged: 1, insertions: 5, deletions: 0,
        agentAuthored: true, agentName: "claude_code",
        author: "agent@x.com", message: "orphan agent commit" },
    ]);
    await initDb(dataDir);

    const s = await getGitStats({ days: 1 });
    expect(s.linked_agent_commits).toBe(1);
    expect(s.unlinked_agent_commits).toBe(0);
  });
});

describe("backfill: no cross-agent linking", () => {
  it("does NOT link a claude_code commit to a codex session even when only codex is active", async () => {
    process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
    const dataDir = mkdtempSync(join(tmpdir(), "observer-attr-noagent-"));
    writeJsonl(join(dataDir, TODAY, "codex", "s_codex.jsonl"), [
      { id: "c1", timestamp: T_SESSION_START, agent: "codex",
        sessionId: "s_codex", project: "alpha", entryType: "tool_call",
        toolName: "shell", tokenUsage: { input: 10, output: 5 } },
      { id: "c2", timestamp: T_SESSION_END, agent: "codex",
        sessionId: "s_codex", project: "alpha", entryType: "tool_call",
        toolName: "shell", tokenUsage: { input: 10, output: 5 } },
    ]);
    writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
      { id: "g_orphan", timestamp: T_COMMIT, eventType: "commit",
        project: "ghost", repo: "owner/ghost", branch: "main",
        commitSha: "deadbeef", filesChanged: 1, insertions: 5, deletions: 0,
        agentAuthored: true, agentName: "claude_code",
        author: "agent@x.com", message: "orphan agent commit" },
    ]);
    await initDb(dataDir);

    const s = await getGitStats({ days: 1 });
    expect(s.unlinked_agent_commits).toBe(1);
    expect(s.linked_agent_commits).toBe(0);
  });
});
