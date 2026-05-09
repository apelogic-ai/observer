import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getValidationLoops } from "../../server/queries";

/**
 * `getValidationLoops(filters)` surfaces "stuck agent" loops — the
 * shape where a validation command (test/lint/typecheck) runs again
 * and again with the same arguments and keeps failing. Distinct from
 * generic stumbles: this requires the call to be a *validation*
 * (matches the same pattern list as /validation) and we report
 * failure count separately, surfaced via the `success` column on
 * the linked tool_result row (PR #25).
 *
 * Per-session-per-command row:
 *   - attempts: how many times the command ran
 *   - failures: how many of those resulted in success=false
 *
 * Filter: only return rows with attempts >= 3. Two failing attempts
 * is just a normal red-green cycle; three is starting to look like a
 * loop.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = (h: number, m = 0) => `${TODAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-loops-"));

  // Session A — clear loop: `bun test x.test.ts` fired 4 times, all failing.
  // The classic stuck-test signature.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "loop.jsonl"), [
    ...mkValidationCycle("loop-sess", "alpha", "bun test x.test.ts", T(9, 0), 4, 0),
    // Surrounding tokens to make the row appear in the rollup.
    { id: "loop-msg", timestamp: T(9, 30), agent: "claude_code", sessionId: "loop-sess",
      project: "alpha", entryType: "message", role: "assistant", assistantText: "trying again",
      tokenUsage: { input: 1000, output: 200, cacheRead: 50000, cacheCreation: 0 } },
  ]);

  // Session B — recovery: `pytest` fired 3 times. First two failed,
  // third succeeded. SHOULD still show up — three attempts is the
  // threshold, but the failures count tells the story (2/3).
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "recover.jsonl"), [
    ...mkValidationCycle("recover-sess", "beta", "pytest tests/test_a.py", T(10, 0), 2, 1),
  ]);

  // Session C — single failure: `npm test` fired once and failed.
  // Should NOT appear — one attempt isn't a loop.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "single.jsonl"), [
    ...mkValidationCycle("single-sess", "gamma", "npm test", T(11, 0), 1, 0),
  ]);

  // Session D — non-validation command repeated. `ls -la` ran 5
  // times. Should NOT appear — only validation-shaped commands count.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "non-val.jsonl"), [
    ...mkRepeatNonValidation("non-val-sess", "delta", "ls -la", T(12, 0), 5),
  ]);

  // Session E — codex shell + pytest loop. Validates that the matcher
  // works for codex-shape tools (toolName="shell" not "Bash").
  writeJsonl(join(DATA_DIR, TODAY, "codex", "codex-loop.jsonl"), [
    ...mkValidationCycle("cx-loop", "gamma", "pytest -k user", T(13, 0), 3, 0, "codex", "shell"),
  ]);

  await initDb(DATA_DIR);
});

/**
 * Helper: emit a tool_call → tool_result pair n times, with
 * `failuresFirst` of the results marked success=false and the rest
 * (n - failuresFirst, well, the n-failuresFirst tail) success=true.
 */
function mkValidationCycle(
  sessionId: string,
  project: string,
  command: string,
  startAt: string,
  failures: number,
  successes: number,
  agent: "claude_code" | "codex" = "claude_code",
  toolName: "Bash" | "shell" = "Bash",
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const total = failures + successes;
  const baseMs = new Date(startAt).getTime();
  for (let i = 0; i < total; i++) {
    const callId = `${sessionId}-call-${i}`;
    const callTs = new Date(baseMs + i * 60_000).toISOString();
    const resultTs = new Date(baseMs + i * 60_000 + 1_000).toISOString();
    const success = i >= failures;
    rows.push({
      id: `${sessionId}-tc-${i}`, timestamp: callTs, agent, sessionId, project,
      entryType: "tool_call", role: "assistant",
      toolName, toolCallId: callId, command,
      tokenUsage: { input: 100, output: 50, cacheRead: 5000, cacheCreation: 0 },
    });
    rows.push({
      id: `${sessionId}-tr-${i}`, timestamp: resultTs, agent, sessionId, project,
      entryType: "tool_result", role: "tool",
      toolName, toolCallId: callId,
      exitCode: success ? 0 : 1, durationMs: 100, success,
    });
  }
  return rows;
}

function mkRepeatNonValidation(
  sessionId: string, project: string, command: string, startAt: string, n: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const baseMs = new Date(startAt).getTime();
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `${sessionId}-tc-${i}`, timestamp: new Date(baseMs + i * 60_000).toISOString(),
      agent: "claude_code", sessionId, project,
      entryType: "tool_call", role: "assistant",
      toolName: "Bash", toolCallId: `${sessionId}-call-${i}`, command,
    });
  }
  return rows;
}

describe("getValidationLoops", () => {
  it("returns sessions where the same validation command ran ≥3 times", async () => {
    const rows = await getValidationLoops({ days: 1 });
    const sessions = new Set(rows.map((r) => r.sessionId));
    expect(sessions.has("loop-sess")).toBe(true);     // 4 attempts
    expect(sessions.has("recover-sess")).toBe(true);  // 3 attempts
    expect(sessions.has("cx-loop")).toBe(true);       // 3 attempts (codex)
  });

  it("excludes sessions with only one or two attempts", async () => {
    const rows = await getValidationLoops({ days: 1 });
    expect(rows.find((r) => r.sessionId === "single-sess")).toBeUndefined();
  });

  it("excludes non-validation repeated commands (ls, cd, …)", async () => {
    const rows = await getValidationLoops({ days: 1 });
    expect(rows.find((r) => r.sessionId === "non-val-sess")).toBeUndefined();
  });

  it("reports attempts and failures separately", async () => {
    const rows = await getValidationLoops({ days: 1 });
    const loop = rows.find((r) => r.sessionId === "loop-sess")!;
    expect(loop.attempts).toBe(4);
    expect(loop.failures).toBe(4);

    const recover = rows.find((r) => r.sessionId === "recover-sess")!;
    expect(recover.attempts).toBe(3);
    expect(recover.failures).toBe(2);  // 2 failed before the green
  });

  it("groups by (sessionId, command) so the same session running two distinct loops shows up twice", async () => {
    // Session F runs TWO different validation loops back-to-back.
    // Each should be its own row.
    const dataDir = mkdtempSync(join(tmpdir(), "observer-loops-multi-"));
    writeJsonl(join(dataDir, TODAY, "claude_code", "two.jsonl"), [
      ...mkValidationCycle("two-loops", "alpha", "bun test a.ts", T(9, 0), 3, 0),
      ...mkValidationCycle("two-loops", "alpha", "bun test b.ts", T(10, 0), 3, 0),
    ]);
    await initDb(dataDir);

    const rows = await getValidationLoops({ days: 1 });
    const twoLoopRows = rows.filter((r) => r.sessionId === "two-loops");
    expect(twoLoopRows.length).toBe(2);
    const commands = twoLoopRows.map((r) => r.command).sort();
    expect(commands).toEqual(["bun test a.ts", "bun test b.ts"]);
  });
});
