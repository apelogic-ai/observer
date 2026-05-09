import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getInterventionRate } from "../../server/queries";

/**
 * `getInterventionRate(filters)` measures how much steering each
 * session needed: per-session user-message count, plus the agent's
 * own work (tool calls, agent-authored commits, LoC) so we can
 * derive ratios like turns-per-commit and tools-per-turn (autonomy
 * proxy — high = agent ran a lot per nudge, low = agent stalled).
 *
 * Only sessions with at least one user turn appear; system-only
 * sessions don't carry quality signal here.
 *
 * Sort: userTurns descending — highest-intervention at the top.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = (h: number, m = 0) => `${TODAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-intervention-"));

  // Session A — heavy intervention: 5 user turns, 10 tool calls. The
  // user kept nudging. tools/turn = 2 (low autonomy).
  writeJsonl(join(dataDir, TODAY, "claude_code", "needy.jsonl"), [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `n-msg-${i}`, timestamp: T(9, i), agent: "claude_code", sessionId: "needy",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: `nudge ${i}`,
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `n-tc-${i}`, timestamp: T(10, i), agent: "claude_code", sessionId: "needy",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "ls",
    })),
  ]);

  // Session B — autonomous: 1 user turn, 30 tool calls. tools/turn = 30
  // (high autonomy).
  writeJsonl(join(dataDir, TODAY, "claude_code", "auto.jsonl"), [
    { id: "a-msg", timestamp: T(11, 0), agent: "claude_code", sessionId: "auto",
      project: "beta", entryType: "message", role: "user",
      userPrompt: "do the thing" },
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `a-tc-${i}`, timestamp: T(11, i + 1), agent: "claude_code", sessionId: "auto",
      project: "beta", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "ls",
    })),
  ]);

  // Session C — system-only (no user turn). Should NOT appear: no
  // intervention signal to report.
  writeJsonl(join(dataDir, TODAY, "claude_code", "sys.jsonl"), [
    { id: "s-tc", timestamp: T(12, 0), agent: "claude_code", sessionId: "sys-only",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "echo hi" },
  ]);

  // Session D — codex with 3 user turns and a commit so we can
  // verify cross-agent + commits/LoC division.
  writeJsonl(join(dataDir, TODAY, "codex", "codex.jsonl"), [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `c-msg-${i}`, timestamp: T(13, i), agent: "codex", sessionId: "codex-sess",
      project: "gamma", entryType: "message", role: "user",
      userPrompt: `q ${i}`,
    })),
    { id: "c-tc", timestamp: T(13, 5), agent: "codex", sessionId: "codex-sess",
      project: "gamma", entryType: "tool_call", role: "assistant",
      toolName: "shell", command: "pytest" },
  ]);
  writeJsonl(join(dataDir, TODAY, "git", "events.jsonl"), [
    { id: "g-codex", timestamp: T(13, 10), eventType: "commit",
      project: "gamma", repo: "owner/gamma", branch: "main",
      commitSha: "abc1234", filesChanged: 1, insertions: 30, deletions: 6,
      agentAuthored: true, agentName: "codex",
      author: "agent@x.com", message: "fix", sessionId: "codex-sess" },
  ]);

  await initDb(dataDir);
});

describe("getInterventionRate", () => {
  it("counts user-turn messages per session", async () => {
    const rows = await getInterventionRate({ days: 1 });
    const needy = rows.find((r) => r.sessionId === "needy");
    expect(needy!.userTurns).toBe(5);
    const auto = rows.find((r) => r.sessionId === "auto");
    expect(auto!.userTurns).toBe(1);
  });

  it("counts tool_call rows per session as toolCalls", async () => {
    const rows = await getInterventionRate({ days: 1 });
    expect(rows.find((r) => r.sessionId === "needy")!.toolCalls).toBe(10);
    expect(rows.find((r) => r.sessionId === "auto")!.toolCalls).toBe(30);
  });

  it("derives toolsPerTurn = toolCalls / userTurns", async () => {
    const rows = await getInterventionRate({ days: 1 });
    const needy = rows.find((r) => r.sessionId === "needy")!;
    expect(needy.toolsPerTurn).toBe(2);
    const auto = rows.find((r) => r.sessionId === "auto")!;
    expect(auto.toolsPerTurn).toBe(30);
  });

  it("excludes sessions with zero user turns", async () => {
    const rows = await getInterventionRate({ days: 1 });
    expect(rows.find((r) => r.sessionId === "sys-only")).toBeUndefined();
  });

  it("counts agent-authored commits + LoC linked to the session", async () => {
    const rows = await getInterventionRate({ days: 1 });
    const cx = rows.find((r) => r.sessionId === "codex-sess")!;
    expect(cx.commits).toBe(1);
    expect(cx.locDelta).toBe(36);  // 30 + 6
    // 3 user turns / 1 commit = 3 turns per commit.
    expect(cx.turnsPerCommit).toBe(3);
  });

  it("sorts by userTurns descending", async () => {
    const rows = await getInterventionRate({ days: 1 });
    const turns = rows.map((r) => r.userTurns);
    expect(turns).toEqual([...turns].sort((a, b) => b - a));
  });

  it("respects project + agent filters", async () => {
    const beta = await getInterventionRate({ days: 1, project: "beta" });
    expect(beta.map((r) => r.sessionId)).toEqual(["auto"]);
    const codex = await getInterventionRate({ days: 1, agent: "codex" });
    expect(codex.map((r) => r.sessionId)).toEqual(["codex-sess"]);
  });
});
