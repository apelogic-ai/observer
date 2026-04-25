/**
 * SQLite data layer (bun:sqlite) — materializes normalized JSONL into
 * in-memory tables.
 *
 * Two tables:
 *   - `traces`     — agent trace entries (claude_code, codex, cursor)
 *   - `git_events` — git commit/PR events
 *
 * Why bun:sqlite instead of DuckDB: DuckDB ships its native binding via
 * @mapbox/node-pre-gyp, which `bun build --compile` can't bundle correctly
 * (the build-host's filesystem path gets baked into the binary). bun:sqlite
 * is built into the Bun runtime — no native binding to ship, no path games.
 *
 * Wide text columns we never query are dropped (fileContent, stdout,
 * toolResultContent, systemPrompt, thinking, reasoning, queryData) — they
 * make up most of the per-row bytes. tokenUsage is stored as a JSON text
 * column so queries can use json_extract().
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

const DEFAULT_DATA_DIR = join(homedir(), ".observer", "traces", "normalized");
const AGENT_DIRS = ["claude_code", "codex", "cursor"];
const REBUILD_DEBOUNCE_MS = 3_000;

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
  if (!_db) {
    _db = new Database(":memory:");
    // WAL doesn't apply to :memory:, but a few pragmas help bulk insert speed.
    _db.exec("PRAGMA synchronous=OFF; PRAGMA journal_mode=MEMORY; PRAGMA temp_store=MEMORY;");
  }
  await rebuild("startup");
  startWatcher();
}

export async function rebuild(reason: string = "manual"): Promise<void> {
  // Coalesce concurrent callers onto the in-flight rebuild.
  if (_rebuilding) return _rebuilding;
  _rebuilding = doBuild(reason).finally(() => { _rebuilding = null; });
  return _rebuilding;
}

// ── Schema ─────────────────────────────────────────────────────────

const SCHEMA_TRACES = `
  CREATE TABLE traces (
    id            TEXT,
    timestamp     TEXT,
    agent         TEXT,
    sessionId     TEXT,
    developer     TEXT,
    machine       TEXT,
    project       TEXT,
    entryType     TEXT,
    role          TEXT,
    model         TEXT,
    tokenUsage    TEXT,         -- JSON: { input, output, cacheRead, cacheCreation, reasoning }
    toolName      TEXT,
    toolCallId    TEXT,
    filePath      TEXT,
    command       TEXT,
    taskSummary   TEXT,
    gitRepo       TEXT,
    gitBranch     TEXT,
    gitCommit     TEXT,
    userPrompt    TEXT,
    assistantText TEXT
  )
`;

const SCHEMA_GIT_EVENTS = `
  CREATE TABLE git_events (
    id              TEXT,
    timestamp       TEXT,
    eventType       TEXT,
    project         TEXT,
    repo            TEXT,
    branch          TEXT,
    developer       TEXT,
    machine         TEXT,
    commitSha       TEXT,
    parentShas      TEXT,        -- JSON array
    filesChanged    INTEGER,
    insertions      INTEGER,
    deletions       INTEGER,
    agentAuthored   INTEGER,     -- 0/1
    agentName       TEXT,
    author          TEXT,
    authorEmail     TEXT,
    coAuthors       TEXT,        -- JSON array
    message         TEXT,
    files           TEXT,        -- JSON array
    sessionId       TEXT,
    prNumber        INTEGER,
    prTitle         TEXT,
    prState         TEXT,
    prUrl           TEXT,
    prBaseBranch    TEXT,
    prHeadBranch    TEXT,
    messageBody     TEXT,
    repoLocal       TEXT
  )
`;

const TRACE_INSERT_COLS = [
  "id", "timestamp", "agent", "sessionId", "developer", "machine", "project",
  "entryType", "role", "model", "tokenUsage",
  "toolName", "toolCallId", "filePath", "command", "taskSummary",
  "gitRepo", "gitBranch", "gitCommit",
  "userPrompt", "assistantText",
] as const;

const GIT_INSERT_COLS = [
  "id", "timestamp", "eventType", "project", "repo", "branch",
  "developer", "machine", "commitSha", "parentShas",
  "filesChanged", "insertions", "deletions",
  "agentAuthored", "agentName", "author", "authorEmail", "coAuthors",
  "message", "files", "sessionId",
  "prNumber", "prTitle", "prState", "prUrl", "prBaseBranch", "prHeadBranch",
  "messageBody", "repoLocal",
] as const;

// ── Build ──────────────────────────────────────────────────────────

async function doBuild(reason: string): Promise<void> {
  if (!_db) throw new Error("Database not initialized");
  const t0 = Date.now();
  const rssBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Drop + re-create. With queries.ts going through the `query()` helper
  // which awaits `_rebuilding`, no concurrent reads can hit the dropped table.
  _db.exec(`DROP TABLE IF EXISTS traces`);
  _db.exec(`DROP TABLE IF EXISTS git_events`);
  _db.exec(SCHEMA_TRACES);
  _db.exec(SCHEMA_GIT_EVENTS);

  if (!existsSync(_dataDir)) {
    _traceRows = 0;
    _gitRows = 0;
    _lastBuildAt = Date.now();
    _lastBuildMs = Date.now() - t0;
    log("db.rebuild", { reason, status: "empty", ms: _lastBuildMs, data_dir: _dataDir });
    return;
  }

  const { traceFiles, gitFiles } = discoverFiles(_dataDir);

  _traceRows = ingestTraces(_db, traceFiles);
  _gitRows = ingestGitEvents(_db, gitFiles);

  // Indexes after bulk insert is faster than during.
  _db.exec(`CREATE INDEX traces_session ON traces(sessionId)`);
  _db.exec(`CREATE INDEX traces_timestamp ON traces(timestamp)`);
  _db.exec(`CREATE INDEX traces_tool ON traces(toolName)`);
  _db.exec(`CREATE INDEX traces_project ON traces(project)`);
  _db.exec(`CREATE INDEX git_events_timestamp ON git_events(timestamp)`);
  _db.exec(`CREATE INDEX git_events_commit ON git_events(commitSha)`);
  _db.exec(`CREATE INDEX git_events_session ON git_events(sessionId)`);

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

// ── Discovery ──────────────────────────────────────────────────────

function discoverFiles(dir: string): { traceFiles: string[]; gitFiles: string[] } {
  const traceFiles: string[] = [];
  const gitFiles: string[] = [];

  for (const dateDir of readdirSync(dir)) {
    const datePath = join(dir, dateDir);
    let subs: string[];
    try { subs = readdirSync(datePath); }
    catch { continue; }

    for (const sub of subs) {
      const subPath = join(datePath, sub);
      let files: string[];
      try { files = readdirSync(subPath); }
      catch { continue; }

      const target = sub === "git" ? gitFiles : (AGENT_DIRS.includes(sub) ? traceFiles : null);
      if (!target) continue;
      for (const f of files) {
        if (f.endsWith(".jsonl")) target.push(join(subPath, f));
      }
    }
  }
  return { traceFiles, gitFiles };
}

// ── Ingestion ──────────────────────────────────────────────────────

function ingestTraces(db: Database, files: string[]): number {
  if (files.length === 0) return 0;

  const placeholders = TRACE_INSERT_COLS.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO traces (${TRACE_INSERT_COLS.join(", ")}) VALUES (${placeholders})`,
  );
  const insertMany = db.transaction((rows: SQLQueryBindings[][]) => {
    for (const row of rows) stmt.run(...row);
  });

  let total = 0;
  for (const file of files) {
    const rows = parseJsonlForTraces(file);
    if (rows.length === 0) continue;
    insertMany(rows);
    total += rows.length;
  }
  return total;
}

function ingestGitEvents(db: Database, files: string[]): number {
  if (files.length === 0) return 0;

  const placeholders = GIT_INSERT_COLS.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO git_events (${GIT_INSERT_COLS.join(", ")}) VALUES (${placeholders})`,
  );
  const insertMany = db.transaction((rows: SQLQueryBindings[][]) => {
    for (const row of rows) stmt.run(...row);
  });

  let total = 0;
  for (const file of files) {
    const rows = parseJsonlForGit(file);
    if (rows.length === 0) continue;
    insertMany(rows);
    total += rows.length;
  }
  return total;
}

function parseJsonlForTraces(file: string): SQLQueryBindings[][] {
  const content = readFileSync(file, "utf-8");
  const out: SQLQueryBindings[][] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    out.push([
      asText(obj.id),
      asText(obj.timestamp),
      asText(obj.agent),
      asText(obj.sessionId),
      asText(obj.developer),
      asText(obj.machine),
      asText(obj.project),
      asText(obj.entryType),
      asText(obj.role),
      asText(obj.model),
      obj.tokenUsage != null ? JSON.stringify(obj.tokenUsage) : null,
      asText(obj.toolName),
      asText(obj.toolCallId),
      asText(obj.filePath),
      asText(obj.command),
      asText(obj.taskSummary),
      asText(obj.gitRepo),
      asText(obj.gitBranch),
      asText(obj.gitCommit),
      asText(obj.userPrompt),
      asText(obj.assistantText),
    ]);
  }
  return out;
}

function parseJsonlForGit(file: string): SQLQueryBindings[][] {
  const content = readFileSync(file, "utf-8");
  const out: SQLQueryBindings[][] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    out.push([
      asText(obj.id),
      asText(obj.timestamp),
      asText(obj.eventType),
      asText(obj.project),
      asText(obj.repo),
      asText(obj.branch),
      asText(obj.developer),
      asText(obj.machine),
      asText(obj.commitSha),
      obj.parentShas != null ? JSON.stringify(obj.parentShas) : null,
      asInt(obj.filesChanged),
      asInt(obj.insertions),
      asInt(obj.deletions),
      obj.agentAuthored === true ? 1 : obj.agentAuthored === false ? 0 : null,
      asText(obj.agentName),
      asText(obj.author),
      asText(obj.authorEmail),
      obj.coAuthors != null ? JSON.stringify(obj.coAuthors) : null,
      asText(obj.message),
      obj.files != null ? JSON.stringify(obj.files) : null,
      asText(obj.sessionId),
      asInt(obj.prNumber),
      asText(obj.prTitle),
      asText(obj.prState),
      asText(obj.prUrl),
      asText(obj.prBaseBranch),
      asText(obj.prHeadBranch),
      asText(obj.messageBody),
      asText(obj.repoLocal),
    ]);
  }
  return out;
}

// ── fs.watch refresh ───────────────────────────────────────────────

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

// ── Query helper ───────────────────────────────────────────────────

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  if (_rebuilding) await _rebuilding;
  return _db.prepare(sql).all() as T[];
}

export function getDataDir(): string {
  return _dataDir;
}

// Coercion helpers — JSONL fields are nominally typed but we narrow at the
// SQLite boundary so SQLQueryBindings is satisfied and no rogue object value
// breaks the prepared statement.
function asText(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}
