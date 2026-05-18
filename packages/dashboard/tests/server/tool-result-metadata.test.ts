import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, query } from "../../server/db";

/**
 * Tool-result metadata (`exitCode`, `durationMs`, `success`) is set by
 * the agent parsers and shipped through normalized JSONL. The
 * dashboard's SQLite schema needs columns for them and the ingest
 * loop has to bind the values. This test plants a JSONL file with
 * the new fields and asserts the dashboard reads them back as the
 * right SQL types (INTEGER for exitCode/durationMs, 0/1 for success).
 */

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.OBSERVER_TEST_ALLOW_FOREIGN_FILTER_BYPASS = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-toolresult-meta-"));
  writeJsonl(join(dataDir, TODAY, "codex", "s.jsonl"), [
    // codex shell tool with structured exit_code + wall time.
    { id: "ok", timestamp: `${TODAY}T10:00:00Z`, agent: "codex", sessionId: "s",
      project: "alpha", entryType: "tool_result", role: "tool",
      toolName: "shell", toolCallId: "c1",
      exitCode: 0, durationMs: 250, success: true },
    // codex shell tool with non-zero exit.
    { id: "fail", timestamp: `${TODAY}T10:01:00Z`, agent: "codex", sessionId: "s",
      project: "alpha", entryType: "tool_result", role: "tool",
      toolName: "shell", toolCallId: "c2",
      exitCode: 1, durationMs: 1500, success: false },
    // claude-shape: no exitCode/durationMs but has success.
    { id: "claude", timestamp: `${TODAY}T10:02:00Z`, agent: "claude_code", sessionId: "s",
      project: "alpha", entryType: "tool_result", role: "tool",
      toolName: "Bash", toolCallId: "c3",
      exitCode: null, durationMs: null, success: true },
    // tool_call (non-result) — metadata fields should stay null.
    { id: "tcall", timestamp: `${TODAY}T10:03:00Z`, agent: "codex", sessionId: "s",
      project: "alpha", entryType: "tool_call", role: "assistant",
      toolName: "shell", toolCallId: "c4" },
  ]);
  await initDb(dataDir);
});

describe("tool-result metadata columns", () => {
  it("populates exitCode + durationMs + success on tool_result rows from codex", async () => {
    const rows = await query<{ id: string; exitCode: number | null; durationMs: number | null; success: number | null }>(
      `SELECT id, exitCode, durationMs, success FROM traces WHERE id = 'ok'`,
    );
    expect(rows[0]).toEqual({ id: "ok", exitCode: 0, durationMs: 250, success: 1 });
  });

  it("non-zero exit lands as success=0", async () => {
    const rows = await query<{ exitCode: number | null; success: number | null }>(
      `SELECT exitCode, success FROM traces WHERE id = 'fail'`,
    );
    expect(rows[0]!.exitCode).toBe(1);
    expect(rows[0]!.success).toBe(0);
  });

  it("claude rows can have success without exitCode/durationMs", async () => {
    const rows = await query<{ exitCode: number | null; durationMs: number | null; success: number | null }>(
      `SELECT exitCode, durationMs, success FROM traces WHERE id = 'claude'`,
    );
    expect(rows[0]!.exitCode).toBeNull();
    expect(rows[0]!.durationMs).toBeNull();
    expect(rows[0]!.success).toBe(1);
  });

  it("non-tool_result rows leave the metadata columns null", async () => {
    const rows = await query<{ exitCode: number | null; durationMs: number | null; success: number | null }>(
      `SELECT exitCode, durationMs, success FROM traces WHERE id = 'tcall'`,
    );
    expect(rows[0]).toEqual({ exitCode: null, durationMs: null, success: null });
  });
});
