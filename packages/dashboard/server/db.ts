/**
 * DuckDB data layer — materializes normalized JSONL into in-memory tables.
 *
 * Two tables:
 *   - `traces`     — agent trace entries (claude_code, codex, cursor)
 *   - `git_events` — git commit/PR events
 *
 * Previously these were views over `read_json_auto(glob)`. That re-parsed
 * every JSONL file on every query; with 8 parallel dashboard requests and
 * wide text columns, peak RSS blew past physical RAM and thrashed swap.
 * Tables are parsed once at startup and refreshed on fs.watch.
 *
 * Traces drop seven heavy text columns never referenced in queries.ts
 * (fileContent, stdout, toolResultContent, systemPrompt, thinking,
 * reasoning, queryData). Those make up most of the per-row bytes.
 */

import { Database } from "duckdb-async";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

const DEFAULT_DATA_DIR = join(homedir(), ".observer", "traces", "normalized");
const AGENT_DIRS = ["claude_code", "codex", "cursor"];
const REBUILD_DEBOUNCE_MS = 3_000;

/** Only the columns queries.ts actually reads. Heavy payload columns omitted. */
const TRACE_COLS = `
  id, timestamp, agent, "sessionId", developer, machine, project,
  "entryType", role, model, "tokenUsage",
  "toolName", "toolCallId", "filePath", command, "taskSummary",
  "gitRepo", "gitBranch", "gitCommit",
  "userPrompt", "assistantText"
`;

let _db: Database | null = null;
let _dataDir: string = DEFAULT_DATA_DIR;
let _rebuilding: Promise<void> | null = null;
let _watcher: FSWatcher | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _traceRows = 0;
let _gitRows = 0;
let _lastBuildAt = 0;
let _lastBuildMs = 0;

export interface DbStats {
  traceRows: number;
  gitRows: number;
  lastBuildAt: number;
  lastBuildMs: number;
}

export function getDbStats(): DbStats {
  return {
    traceRows: _traceRows,
    gitRows: _gitRows,
    lastBuildAt: _lastBuildAt,
    lastBuildMs: _lastBuildMs,
  };
}

export async function initDb(dataDir?: string): Promise<void> {
  _dataDir = dataDir ?? DEFAULT_DATA_DIR;
  if (!_db) _db = await Database.create(":memory:");
  await rebuild("startup");
  startWatcher();
}

export async function rebuild(reason: string = "manual"): Promise<void> {
  // Coalesce concurrent callers onto the in-flight rebuild.
  if (_rebuilding) return _rebuilding;
  _rebuilding = doBuild(reason).finally(() => { _rebuilding = null; });
  return _rebuilding;
}

async function doBuild(reason: string): Promise<void> {
  if (!_db) throw new Error("Database not initialized");
  const t0 = Date.now();
  const rssBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);

  if (!existsSync(_dataDir)) {
    // Empty schemas so queries don't throw; dashboard renders an empty state.
    await _db.exec(`CREATE OR REPLACE TABLE traces (id VARCHAR, timestamp VARCHAR)`);
    await _db.exec(`CREATE OR REPLACE TABLE git_events (id VARCHAR, timestamp VARCHAR, "eventType" VARCHAR)`);
    _traceRows = 0;
    _gitRows = 0;
    _lastBuildAt = Date.now();
    _lastBuildMs = Date.now() - t0;
    log("db.rebuild", { reason, status: "empty", ms: _lastBuildMs, data_dir: _dataDir });
    return;
  }

  // DuckDB's ignore_errors doesn't swallow "glob matched zero files", so
  // only include subdirectories that are actually present on disk.
  const { agentDirs, hasGit } = discoverSubdirs(_dataDir);

  if (agentDirs.length === 0) {
    await _db.exec(`CREATE OR REPLACE TABLE traces (id VARCHAR, timestamp VARCHAR)`);
    _traceRows = 0;
  } else {
    const agentGlobs = agentDirs
      .map((a) => `'${join(_dataDir, "**", a, "*.jsonl").replace(/'/g, "''")}'`)
      .join(", ");
    // CREATE OR REPLACE is atomic in DuckDB — concurrent readers see either
    // the old or new table, never a dropped one mid-query.
    await _db.exec(`
      CREATE OR REPLACE TABLE traces AS
      SELECT ${TRACE_COLS}
      FROM read_json_auto(
        [${agentGlobs}],
        union_by_name = true,
        ignore_errors = true,
        maximum_object_size = 16777216
      )
    `);
  }

  if (!hasGit) {
    await _db.exec(`CREATE OR REPLACE TABLE git_events (id VARCHAR, timestamp VARCHAR, "eventType" VARCHAR)`);
    _gitRows = 0;
  } else {
    const gitGlob = `'${join(_dataDir, "**", "git", "*.jsonl").replace(/'/g, "''")}'`;
    await _db.exec(`
      CREATE OR REPLACE TABLE git_events AS
      SELECT *
      FROM read_json_auto(
        ${gitGlob},
        union_by_name = true,
        ignore_errors = true
      )
    `);
  }

  const tCount = await _db.all(`SELECT COUNT(*)::BIGINT AS n FROM traces`) as Array<{ n: bigint }>;
  const gCount = await _db.all(`SELECT COUNT(*)::BIGINT AS n FROM git_events`) as Array<{ n: bigint }>;
  _traceRows = Number(tCount[0]?.n ?? 0);
  _gitRows = Number(gCount[0]?.n ?? 0);
  _lastBuildAt = Date.now();
  _lastBuildMs = Date.now() - t0;

  const rssAfter = Math.round(process.memoryUsage().rss / 1024 / 1024);
  log("db.rebuild", {
    reason,
    status: "ok",
    rows_traces: _traceRows,
    rows_git: _gitRows,
    ms: _lastBuildMs,
    rss_before_mb: rssBefore,
    rss_after_mb: rssAfter,
    rss_delta_mb: rssAfter - rssBefore,
  });
}

function discoverSubdirs(dir: string): { agentDirs: string[]; hasGit: boolean } {
  const agents = new Set<string>();
  let hasGit = false;
  for (const dateDir of readdirSync(dir)) {
    const datePath = join(dir, dateDir);
    try {
      for (const sub of readdirSync(datePath)) {
        if (AGENT_DIRS.includes(sub)) agents.add(sub);
        else if (sub === "git") hasGit = true;
      }
    } catch { /* dateDir wasn't a directory — skip */ }
  }
  return { agentDirs: [...agents], hasGit };
}

function startWatcher(): void {
  if (_watcher || !existsSync(_dataDir)) return;
  try {
    _watcher = watch(_dataDir, { recursive: true }, (_event, filename) => {
      if (!filename || !String(filename).endsWith(".jsonl")) return;
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        rebuild("fs.watch").catch((err) => log("db.rebuild.error", { err: String(err) }));
      }, REBUILD_DEBOUNCE_MS);
    });
    log("db.watch", { data_dir: _dataDir, debounce_ms: REBUILD_DEBOUNCE_MS });
  } catch (err) {
    log("db.watch.error", { err: String(err) });
  }
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  if (_rebuilding) await _rebuilding;
  return _db.all(sql) as Promise<T[]>;
}

export function getDataDir(): string {
  return _dataDir;
}
