import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, query } from "../../server/db";

/**
 * Regression test for the e2e failure on PR #25 — adding columns to
 * TRACE_INSERT_COLS without updating `ingestCursorSidecars`'s
 * hand-listed bind. bun:sqlite throws "expected N values, received M"
 * when the placeholder count and bind length disagree, which crashes
 * `initDb` before any HTTP test runs. Caught only by the e2e seed,
 * which actually plants a cursor sidecar.
 *
 * This unit-level test plants the same shape and asserts initDb
 * completes — fails 100x faster than e2e and isolates the
 * sidecar-bind path from the JSONL-bind path.
 *
 * Lives in its own file so its initDb call doesn't clobber other
 * test files' fixtures (db.ts holds a singleton _db).
 */

beforeAll(async () => {
  process.env.OBSERVER_TEST_ALLOW_FOREIGN_FILTER_BYPASS = "1";
  const dataDir = mkdtempSync(join(tmpdir(), "observer-cursor-sidecar-"));
  const day = "2026-04-01";
  mkdirSync(join(dataDir, day, "cursor"), { recursive: true });
  writeFileSync(
    join(dataDir, day, "cursor", "_usage.json"),
    JSON.stringify({
      date: day,
      totals: { input: 1000, output: 500, cacheRead: 9000, cacheCreation: 0, reasoning: 0 },
    }),
  );
  // initDb throws if the bind list has fewer values than the schema
  // expects — that's the exact e2e regression. The await won't
  // resolve normally on the bug.
  await initDb(dataDir);
});

describe("cursor sidecar ingest after schema changes", () => {
  it("loads a _usage.json sidecar without throwing on bun:sqlite bind length", async () => {
    const rows = await query<{ id: string; tokenUsage: string }>(
      `SELECT id, tokenUsage FROM traces WHERE id LIKE 'cursor-usage-%'`,
    );
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]!.tokenUsage).input).toBe(1000);
  });
});
