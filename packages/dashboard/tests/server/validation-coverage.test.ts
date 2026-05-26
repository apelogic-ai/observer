import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getValidationCoverage } from "../../server/queries";

/**
 * `getValidationCoverage(filters)` answers "did the agent verify its
 * own work before finishing?" — the highest-signal session-quality
 * flag we can compute on existing data. Per session:
 *
 *   - lastEditAt: latest tool_call timestamp on Edit/Write/apply_patch/...
 *   - lastValidationAt: latest tool_call timestamp on Bash/shell where
 *     `command` looks like a test/lint/typecheck/build invocation
 *   - validatedAfterEdit: lastValidationAt > lastEditAt (both non-null)
 *
 * Only sessions that actually edited code appear — exploration-only
 * sessions (no edits) aren't a quality concern; flagging them as
 * "didn't validate" is noise.
 *
 * Sort: by tokens descending. The headline use case is the
 * expensive-flail session — high spend, code shipped, nobody ran the
 * tests.
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);
const T = (h: number, m = 0) => `${TODAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

let DATA_DIR: string;

beforeAll(async () => {
  process.env.OBSERVER_TEST_ALLOW_FOREIGN_FILTER_BYPASS = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-validation-"));

  // Session A: edited, then validated (the good case).
  // Edit at 09:00, bun test at 09:30 → validatedAfterEdit=true.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "good.jsonl"), [
    { id: "a1", timestamp: T(9, 0), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/index.ts" },
    { id: "a2", timestamp: T(9, 30), agent: "claude_code", sessionId: "good",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "bun test src/index.test.ts",
      tokenUsage: { input: 5000, output: 1000, cacheRead: 95000, cacheCreation: 0 } },
  ]);

  // Session B: edited, then validated, then edited AGAIN — validation
  // is now stale. Should flag as validatedAfterEdit=false.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "stale.jsonl"), [
    { id: "b1", timestamp: T(10, 0), agent: "claude_code", sessionId: "stale",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/a.ts" },
    { id: "b2", timestamp: T(10, 15), agent: "claude_code", sessionId: "stale",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "bun run test",
      tokenUsage: { input: 1000, output: 200, cacheRead: 50000, cacheCreation: 0 } },
    { id: "b3", timestamp: T(10, 30), agent: "claude_code", sessionId: "stale",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Edit", filePath: "src/b.ts" },
  ]);

  // Session C: edited, never validated. Big token spend — the
  // quintessential expensive-flail case the page is built to
  // surface.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "flail.jsonl"), [
    { id: "c1", timestamp: T(11, 0), agent: "claude_code", sessionId: "flail",
      project: "beta", entryType: "tool_call", role: "assistant",
      toolName: "Write", filePath: "src/big.ts",
      tokenUsage: { input: 500000, output: 50000, cacheRead: 9000000, cacheCreation: 0 } },
    { id: "c2", timestamp: T(11, 30), agent: "claude_code", sessionId: "flail",
      project: "beta", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "ls -la",  // not a validation command
      tokenUsage: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 0 } },
  ]);

  // Session D: explored (Read/Bash but no Edit). Should NOT appear in
  // the coverage report — nothing was edited, no quality signal.
  writeJsonl(join(DATA_DIR, TODAY, "claude_code", "explore.jsonl"), [
    { id: "d1", timestamp: T(12, 0), agent: "claude_code", sessionId: "explore",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Read", filePath: "README.md" },
    { id: "d2", timestamp: T(12, 5), agent: "claude_code", sessionId: "explore",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "Bash", command: "git status" },
  ]);

  // Session E: codex apply_patch + shell `pytest` — proves the
  // matching covers codex tools too.
  writeJsonl(join(DATA_DIR, TODAY, "codex", "codex-good.jsonl"), [
    { id: "e1", timestamp: T(13, 0), agent: "codex", sessionId: "cx-good",
      project: "gamma", entryType: "tool_call", role: "assistant",
      toolName: "edit", filePath: "src/a.py" },     // codex normalizes apply_patch → edit
    { id: "e2", timestamp: T(13, 15), agent: "codex", sessionId: "cx-good",
      project: "gamma", entryType: "tool_call", role: "assistant",
      toolName: "shell", command: "pytest tests/" },
  ]);

  await initDb(DATA_DIR);
});

describe("getValidationCoverage", () => {
  it("flags edit-then-validate sessions as validatedAfterEdit=true", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    const good = rows.find((r) => r.sessionId === "good");
    expect(good).toBeDefined();
    expect(good!.validatedAfterEdit).toBe(true);
    expect(good!.lastEditAt).toBe(T(9, 0));
    expect(good!.lastValidationAt).toBe(T(9, 30));
  });

  it("flags edit-after-validation as STALE (validatedAfterEdit=false)", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    const stale = rows.find((r) => r.sessionId === "stale");
    expect(stale).toBeDefined();
    expect(stale!.validatedAfterEdit).toBe(false);
    expect(stale!.lastEditAt).toBe(T(10, 30));   // the SECOND edit
    expect(stale!.lastValidationAt).toBe(T(10, 15));
  });

  it("flags edit-without-validation as validatedAfterEdit=false (lastValidationAt null)", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    const flail = rows.find((r) => r.sessionId === "flail");
    expect(flail).toBeDefined();
    expect(flail!.validatedAfterEdit).toBe(false);
    expect(flail!.lastValidationAt).toBeNull();
  });

  it("excludes sessions that never edited code (no quality signal)", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    expect(rows.find((r) => r.sessionId === "explore")).toBeUndefined();
  });

  it("recognizes codex-shape edit + shell validation tools", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    const cx = rows.find((r) => r.sessionId === "cx-good");
    expect(cx).toBeDefined();
    expect(cx!.agent).toBe("codex");
    expect(cx!.validatedAfterEdit).toBe(true);
  });

  it("sorts un-validated sessions by tokens desc (expensive flail at top)", async () => {
    const rows = await getValidationCoverage({ days: 1 });
    const unvalidated = rows.filter((r) => !r.validatedAfterEdit);
    // flail (~9.5M tokens) should rank above stale (~51K tokens).
    const ids = unvalidated.map((r) => r.sessionId);
    expect(ids.indexOf("flail")).toBeLessThan(ids.indexOf("stale"));
  });

  it("respects project + agent filters", async () => {
    const beta = await getValidationCoverage({ days: 1, project: "beta" });
    expect(beta.map((r) => r.sessionId)).toEqual(["flail"]);
    const codexOnly = await getValidationCoverage({ days: 1, agent: "codex" });
    expect(codexOnly.map((r) => r.sessionId)).toEqual(["cx-good"]);
  });
});
