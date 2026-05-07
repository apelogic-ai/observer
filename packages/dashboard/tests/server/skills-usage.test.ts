import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getSkillUsage, getSkillSessions } from "../../server/queries";

/**
 * `getSkillUsage(filters)` powers the dedicated /skills page. Two
 * signals contribute to the same skill name:
 *
 *   - "slash" — user prompts of the form `/<name> ...` (typed by the
 *     human; covers slash commands like `/ship`, `/loop`).
 *   - "tool"  — `Skill(command="<name>")` invocations the model fired,
 *     captured in tool_calls as `toolName = "skill:<name>"`.
 *
 * The two are unioned + grouped by canonical name (no leading slash)
 * so a skill exercised both ways shows up as a single row with both
 * sources flagged.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T_OLD = `${TODAY}T08:00:00Z`;
const T_MID = `${TODAY}T10:00:00Z`;
const T_NEW = `${TODAY}T14:00:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-skills-usage-"));

  // Slash prompts (entryType=message, role=user, userPrompt starts /).
  // - /ship typed twice in s1 (alpha) and once in s2 (beta).
  // - /loop typed once in s1 (alpha).
  // - /help typed once in s3 (alpha) — only-slash skill.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s1.jsonl"), [
    { id: "p1", timestamp: T_OLD, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: "/ship now please" },
    { id: "p2", timestamp: T_MID, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: "/ship again" },
    { id: "p3", timestamp: T_MID, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: "/loop start" },
    // Skill tool calls in the SAME session — `skill:ship` lives in
    // tool_calls, not messages. This skill should end up flagged with
    // BOTH "slash" and "tool" sources after the union.
    { id: "t1", timestamp: T_NEW, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "tool_call", toolName: "skill:ship",
      tokenUsage: { input: 10, output: 5 } },
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s2.jsonl"), [
    { id: "p4", timestamp: T_NEW, agent: "claude_code", sessionId: "s2",
      project: "beta", entryType: "message", role: "user",
      userPrompt: "/ship one more" },
    // Tool-only skill: `pdf` is fired by the model, never typed.
    { id: "t2", timestamp: T_OLD, agent: "claude_code", sessionId: "s2",
      project: "beta", entryType: "tool_call", toolName: "skill:pdf",
      tokenUsage: { input: 20, output: 10 } },
    { id: "t3", timestamp: T_MID, agent: "claude_code", sessionId: "s2",
      project: "beta", entryType: "tool_call", toolName: "skill:pdf",
      tokenUsage: { input: 20, output: 10 } },
  ]);

  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "s3.jsonl"), [
    { id: "p5", timestamp: T_NEW, agent: "claude_code", sessionId: "s3",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: "/help" },
  ]);

  // Codex agent — verifies the agent filter excludes when needed.
  writeJsonl(join(DATA_DIR, TODAY, "codex", "s4.jsonl"), [
    { id: "p6", timestamp: T_MID, agent: "codex", sessionId: "s4",
      project: "alpha", entryType: "message", role: "user",
      userPrompt: "/ship from codex" },
  ]);

  await initDb(DATA_DIR);
});

describe("getSkillUsage", () => {
  it("unions slash prompts + skill: tool calls into one row per canonical name", async () => {
    const rows = await getSkillUsage({ days: 1 });
    const names = rows.map((r) => r.name).sort();
    // Every canonical skill, no leading slash, no `skill:` prefix.
    expect(names).toEqual(["help", "loop", "pdf", "ship"]);
  });

  it("counts invocations across both sources and reports them in `count`", async () => {
    const rows = await getSkillUsage({ days: 1 });
    const ship = rows.find((r) => r.name === "ship")!;
    // 4 slash prompts (p1, p2, p4 in claude + p6 in codex) + 1 tool
    // call (t1 in claude) = 5 total when no agent filter is applied.
    expect(ship.count).toBe(5);
    const pdf = rows.find((r) => r.name === "pdf")!;
    expect(pdf.count).toBe(2);  // tool-only, fired twice
    const loop = rows.find((r) => r.name === "loop")!;
    expect(loop.count).toBe(1); // slash-only, once
  });

  it("returns sorted distinct agents that fired each skill", async () => {
    const rows = await getSkillUsage({ days: 1 });
    // /ship was typed in claude_code (s1, s2) AND in codex (s4),
    // and skill:ship fired in claude_code (s1). Both agents.
    const ship = rows.find((r) => r.name === "ship")!;
    expect(ship.agents).toEqual(["claude_code", "codex"]);
    // /loop only typed in claude_code; skill:pdf only fired in claude_code.
    const loop = rows.find((r) => r.name === "loop")!;
    expect(loop.agents).toEqual(["claude_code"]);
    const pdf = rows.find((r) => r.name === "pdf")!;
    expect(pdf.agents).toEqual(["claude_code"]);
  });

  it("counts distinct sessions across both sources", async () => {
    const rows = await getSkillUsage({ days: 1 });
    // /ship typed in s1, s2, s4 + skill:ship fired in s1 → 3 distinct sessions
    const ship = rows.find((r) => r.name === "ship")!;
    expect(ship.sessions).toBe(3);
    // skill:pdf fired only in s2
    const pdf = rows.find((r) => r.name === "pdf")!;
    expect(pdf.sessions).toBe(1);
  });

  it("reports first-seen and last-seen timestamps spanning both sources", async () => {
    const rows = await getSkillUsage({ days: 1 });
    const ship = rows.find((r) => r.name === "ship")!;
    expect(ship.firstSeen).toBe(T_OLD);  // p1 — slash, the earliest
    expect(ship.lastSeen).toBe(T_NEW);   // p4 / t1 tied at T_NEW
  });

  it("counts distinct projects each skill appears in", async () => {
    const rows = await getSkillUsage({ days: 1 });
    const ship = rows.find((r) => r.name === "ship")!;
    expect(ship.projects).toBe(2);  // alpha + beta
    const help = rows.find((r) => r.name === "help")!;
    expect(help.projects).toBe(1);
  });

  it("sorts by count desc, breaking ties by name asc", async () => {
    const rows = await getSkillUsage({ days: 1 });
    const ordered = rows.map((r) => r.name);
    // ship=5 first, pdf=2 next, then help=1 / loop=1 tied → alpha-sorted.
    expect(ordered).toEqual(["ship", "pdf", "help", "loop"]);
  });

  it("respects the project filter on both sources", async () => {
    const rows = await getSkillUsage({ project: "beta", days: 1 });
    // beta has /ship (p4) + skill:pdf (t2,t3). No /loop, no /help.
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["pdf", "ship"]);
    const ship = rows.find((r) => r.name === "ship")!;
    expect(ship.count).toBe(1);
    expect(ship.agents).toEqual(["claude_code"]);
  });

  it("respects the agent filter on both sources", async () => {
    const rows = await getSkillUsage({ agent: "codex", days: 1 });
    // codex contributed only /ship in s4.
    expect(rows.length).toBe(1);
    expect(rows[0]!.name).toBe("ship");
    expect(rows[0]!.count).toBe(1);
    expect(rows[0]!.agents).toEqual(["codex"]);
  });

  it("returns an empty array when filters match nothing", async () => {
    const rows = await getSkillUsage({ project: "ghost", days: 1 });
    expect(rows).toEqual([]);
  });

  describe("getSkillSessions (drill-down)", () => {
    it("returns one row per (sessionId, agent) that fired the named skill", async () => {
      // /ship + skill:ship landed in s1 (claude/alpha), s2 (claude/beta),
      // s4 (codex/alpha). Expect 3 distinct rows.
      const rows = await getSkillSessions("ship", { days: 1 });
      const sessionIds = rows.map((r) => r.sessionId).sort();
      expect(sessionIds).toEqual(["s1", "s2", "s4"]);
    });

    it("aggregates count + first/last seen + agent + project per session", async () => {
      const rows = await getSkillSessions("ship", { days: 1 });
      const s1 = rows.find((r) => r.sessionId === "s1")!;
      // s1 has p1 (slash), p2 (slash), t1 (tool) = 3 invocations
      expect(s1.count).toBe(3);
      expect(s1.agent).toBe("claude_code");
      expect(s1.project).toBe("alpha");
      expect(s1.firstSeen).toBe(T_OLD);   // p1
      expect(s1.lastSeen).toBe(T_NEW);    // t1
    });

    it("sorts by lastSeen desc (most-recent session first)", async () => {
      const rows = await getSkillSessions("ship", { days: 1 });
      // s1 has t1 at T_NEW; s2 has p4 at T_NEW; s4 has p6 at T_MID.
      // Among the two T_NEW sessions, ordering is implementation-defined,
      // but s4 (T_MID) must come last.
      expect(rows[rows.length - 1]!.sessionId).toBe("s4");
    });

    it("respects the same project / agent / days filters as getSkillUsage", async () => {
      const rows = await getSkillSessions("ship", { agent: "codex", days: 1 });
      expect(rows.length).toBe(1);
      expect(rows[0]!.sessionId).toBe("s4");
    });

    it("returns an empty array for an unknown skill", async () => {
      const rows = await getSkillSessions("does-not-exist", { days: 1 });
      expect(rows).toEqual([]);
    });
  });

  it("rejects messages that start with a Unix path (`/private/tmp/...`) as not-a-slash-command", async () => {
    // Real-world traces contain pasted commands / pathy prompts that
    // start with `/`. Without a name-shape filter the dashboard
    // surfaces them as the top "skill", which is misleading.
    const localDir = mkdtempSync(join(tmpdir(), "observer-skills-paths-"));
    writeJsonl(join(localDir, TODAY, "claude_code", "px.jsonl"), [
      { id: "x1", timestamp: T_MID, agent: "claude_code", sessionId: "x1",
        project: "alpha", entryType: "message", role: "user",
        userPrompt: "/private/tmp/some/path is that ok" },
      { id: "x2", timestamp: T_MID, agent: "claude_code", sessionId: "x2",
        project: "alpha", entryType: "message", role: "user",
        userPrompt: "/well-formed-skill arg" },
      // Plugin-namespaced skill from a tool call — `git-flow:ship` is a
      // real example from Claude Code. The colon must survive the
      // canonical-name filter or every plugin skill gets dropped.
      { id: "t-plugin", timestamp: T_NEW, agent: "claude_code", sessionId: "x3",
        project: "alpha", entryType: "tool_call", toolName: "skill:git-flow:ship",
        tokenUsage: { input: 1, output: 1 } },
    ]);
    await initDb(localDir);
    const rows = await getSkillUsage({ days: 1 });
    const names = rows.map((r) => r.name);
    expect(names).toContain("well-formed-skill");
    expect(names).toContain("git-flow:ship");
    expect(names.some((n) => n.includes("/"))).toBe(false);
    expect(names.some((n) => /\s/.test(n))).toBe(false);
  });
});
