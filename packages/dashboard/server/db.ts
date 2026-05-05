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

// Marker emitted by the agent's secret scanner — `[REDACTED:<type>]`.
// The dashboard derives security findings purely from these markers
// (no separate data entity, no shipping changes). Counts and session
// attribution come from the row the marker was found in.
const SCHEMA_SECURITY_FINDINGS = `
  CREATE TABLE security_findings (
    timestamp    TEXT,
    agent        TEXT,
    sessionId    TEXT,
    project      TEXT,
    patternType  TEXT,
    -- which trace row the marker came from (id from the source JSONL)
    sourceId     TEXT,
    -- which field on that row had the marker — useful for drill-down
    field        TEXT
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
  _db.exec(`DROP TABLE IF EXISTS security_findings`);
  _db.exec(SCHEMA_TRACES);
  _db.exec(SCHEMA_GIT_EVENTS);
  _db.exec(SCHEMA_SECURITY_FINDINGS);

  if (!existsSync(_dataDir)) {
    _traceRows = 0;
    _gitRows = 0;
    _lastBuildAt = Date.now();
    _lastBuildMs = Date.now() - t0;
    log("db.rebuild", { reason, status: "empty", ms: _lastBuildMs, data_dir: _dataDir });
    return;
  }

  const { traceFiles, gitFiles, cursorSidecars } = discoverFiles(_dataDir);

  _traceRows = ingestTraces(_db, traceFiles);
  _gitRows = ingestGitEvents(_db, gitFiles);
  // Cursor doesn't write consumed-token counts to disk. The agent's
  // `cursor.fetchUsage` opt-in writes per-day _usage.json sidecars from
  // Cursor's API; inject them as synthetic summary rows so the existing
  // token aggregations pick them up. sessionId=null keeps these out of
  // the session list (honest: we can't attribute to a specific composer).
  _traceRows += ingestCursorSidecars(_db, cursorSidecars);

  // Drop teammates' commits from shared repos. The agent's
  // `git.onlySelf` (default true in v0.1.9+) filters at *collection* time
  // — but anything written to disk before that fix landed is still on
  // disk and shows up here. Apply the same filter at ingest so old data
  // gets cleaned without forcing a rescan.
  _gitRows -= filterForeignGitCommits(_db);

  // Older on-disk git_events have sessionId=null whenever the commit was
  // attributed via Co-Authored-By (the agent's scanner short-circuited
  // session-window matching for those). Re-do the window match here so
  // commits link back to their parent session in the UI.
  const filled = backfillCommitSessions(_db);
  if (filled > 0) log("db.backfill_sessions", { commits_linked: filled });

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

function discoverFiles(dir: string): {
  traceFiles: string[];
  gitFiles: string[];
  cursorSidecars: string[];
} {
  const traceFiles: string[] = [];
  const gitFiles: string[] = [];
  const cursorSidecars: string[] = [];

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
        else if (sub === "cursor" && f === "_usage.json") cursorSidecars.push(join(subPath, f));
      }
    }
  }
  return { traceFiles, gitFiles, cursorSidecars };
}

// ── Ingestion ──────────────────────────────────────────────────────

function ingestTraces(db: Database, files: string[]): number {
  if (files.length === 0) return 0;

  const tracePlaceholders = TRACE_INSERT_COLS.map(() => "?").join(", ");
  const traceStmt = db.prepare(
    `INSERT INTO traces (${TRACE_INSERT_COLS.join(", ")}) VALUES (${tracePlaceholders})`,
  );
  const findingStmt = db.prepare(
    `INSERT INTO security_findings (timestamp, agent, sessionId, project, patternType, sourceId, field) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((trace: SQLQueryBindings[][], findings: SQLQueryBindings[][]) => {
    for (const row of trace) traceStmt.run(...row);
    for (const row of findings) findingStmt.run(...row);
  });

  let total = 0;
  for (const file of files) {
    const { traceRows, findingRows } = parseJsonlForTraces(file);
    if (traceRows.length === 0 && findingRows.length === 0) continue;
    insertMany(traceRows, findingRows);
    total += traceRows.length;
  }
  return total;
}

/**
 * Inject one synthetic trace row per cursor `_usage.json` sidecar.
 *
 * The sidecar carries the day's real input/output/cache token totals that
 * Cursor's API returns (Cursor doesn't write these to disk locally — see
 * packages/agent/src/cursor-api.ts). We insert with sessionId=null so
 * `getSessions` (which filters on `sessionId IS NOT NULL`) doesn't surface
 * these as fake sessions; token-aggregation queries (which sum tokenUsage
 * across all rows) pick them up automatically.
 */
function ingestCursorSidecars(db: Database, paths: string[]): number {
  if (paths.length === 0) return 0;
  const placeholders = TRACE_INSERT_COLS.map(() => "?").join(", ");
  const stmt = db.prepare(
    `INSERT INTO traces (${TRACE_INSERT_COLS.join(", ")}) VALUES (${placeholders})`,
  );

  let n = 0;
  for (const path of paths) {
    let payload: { date?: string; totals?: Record<string, number> };
    try { payload = JSON.parse(readFileSync(path, "utf-8")); }
    catch { continue; }
    if (!payload.date || !payload.totals) continue;

    const t = payload.totals;
    const tokenUsage = JSON.stringify({
      input: t.input ?? 0,
      output: t.output ?? 0,
      cacheRead: t.cacheRead ?? 0,
      cacheCreation: t.cacheCreation ?? 0,
      reasoning: t.reasoning ?? 0,
    });
    // End-of-day timestamp so the row falls in the same date bucket as
    // the day it represents.
    const ts = `${payload.date}T23:59:00.000Z`;

    // Order must match TRACE_INSERT_COLS.
    stmt.run(
      `cursor-usage-${payload.date}`,  // id
      ts,                              // timestamp
      "cursor",                        // agent
      null,                            // sessionId — keep out of session list
      null, null, null,                // developer, machine, project
      "usage_summary",                 // entryType
      null, null,                      // role, model
      tokenUsage,                      // tokenUsage
      null, null, null, null, null,    // toolName … taskSummary
      null, null, null,                // gitRepo, gitBranch, gitCommit
      null, null,                      // userPrompt, assistantText
    );
    n++;
  }
  return n;
}

/** Read the developer email/name from the agent's config.yaml, if present.
 *  Tests set `OBSERVER_SKIP_FOREIGN_FILTER=1` to short-circuit the filter
 *  so fixture commits with synthetic authors don't get dropped. */
function readDeveloperFromAgentConfig(): string | null {
  if (process.env.OBSERVER_SKIP_FOREIGN_FILTER) return null;
  const cfgPath = join(homedir(), ".observer", "config.yaml");
  if (!existsSync(cfgPath)) return null;
  try {
    const text = readFileSync(cfgPath, "utf-8");
    // Tolerate any quoting style; "developer:" line is enough for this filter.
    const m = /^developer:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Drop git_events whose author/authorEmail doesn't match the configured
 *  developer. Returns rows deleted. Idempotent; no-op when no config. */
function filterForeignGitCommits(db: Database): number {
  const dev = readDeveloperFromAgentConfig();
  if (!dev) return 0;
  const lower = dev.toLowerCase();
  // Match the agent's filterByAuthor semantics: equality on either field
  // OR substring match (so "lbelyaev" matches "lbelyaev@example.com").
  const stmt = db.prepare(
    `DELETE FROM git_events
       WHERE NOT (
         LOWER(COALESCE(author,''))      = ? OR
         LOWER(COALESCE(authorEmail,'')) = ? OR
         INSTR(LOWER(COALESCE(author,'')),      ?) > 0 OR
         INSTR(LOWER(COALESCE(authorEmail,'')), ?) > 0
       )`,
  );
  const res = stmt.run(lower, lower, lower, lower);
  return res.changes;
}

/**
 * Backfill missing sessionId on git_events using the same logic as the
 * agent's `attributeFromSessions`: a commit gets a sessionId iff its
 * timestamp falls within [session.start - 5min, session.end + 5min] for
 * a session in the same project. The agent only ran this for commits
 * NOT yet attributed via Co-Authored-By, so older on-disk data has
 * agent_authored=true but sessionId=null. We do the lookup at ingest
 * (in-memory only — no files rewritten) so the dashboard can show a
 * commit's parent session correctly without a forced rescan.
 */
function backfillCommitSessions(db: Database): number {
  const BUFFER_MS = 5 * 60 * 1000;
  const sessions = db
    .prepare(
      `SELECT sessionId, project, agent,
              MIN(timestamp) AS started, MAX(timestamp) AS ended
         FROM traces
        WHERE sessionId IS NOT NULL AND project IS NOT NULL
        GROUP BY sessionId, project`,
    )
    .all() as { sessionId: string; project: string; agent: string; started: string; ended: string }[];
  if (sessions.length === 0) return 0;

  // Bucket sessions by project so the per-commit search is O(sessions-in-project).
  const byProject = new Map<string, { sessionId: string; agent: string; start: number; end: number }[]>();
  for (const s of sessions) {
    const start = new Date(s.started).getTime();
    const end = new Date(s.ended).getTime();
    if (isNaN(start) || isNaN(end)) continue;
    const list = byProject.get(s.project) ?? [];
    list.push({ sessionId: s.sessionId, agent: s.agent, start: start - BUFFER_MS, end: end + BUFFER_MS });
    byProject.set(s.project, list);
  }

  const orphans = db
    .prepare(
      `SELECT commitSha, project, timestamp
         FROM git_events
        WHERE sessionId IS NULL AND project IS NOT NULL`,
    )
    .all() as { commitSha: string; project: string; timestamp: string }[];

  const update = db.prepare(
    `UPDATE git_events SET sessionId = ?, agentAuthored = 1, agentName = COALESCE(agentName, ?) WHERE commitSha = ?`,
  );
  let filled = 0;
  for (const c of orphans) {
    const candidates = byProject.get(c.project);
    if (!candidates) continue;
    const ts = new Date(c.timestamp).getTime();
    if (isNaN(ts)) continue;
    for (const s of candidates) {
      if (ts >= s.start && ts <= s.end) {
        update.run(s.sessionId, s.agent, c.commitSha);
        filled++;
        break;
      }
    }
  }
  return filled;
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

// Fields where the agent's secret-scanner can leave a `[REDACTED:...]`
// marker. We attribute each finding to its source field for drill-down
// later. Critically this list includes the wide text columns (stdout,
// fileContent, toolResultContent, queryData) that the dashboard drops
// before insert — those are exactly where leaks are most likely to
// land at disclosure: full, and scanning has to happen here, before
// the drop, or the security page silently undercounts.
const FINDING_FIELDS = [
  "command", "filePath", "taskSummary", "userPrompt", "assistantText",
  "stdout", "fileContent", "toolResultContent", "queryData",
] as const;
const REDACTED_MARKER_RE = /\[REDACTED:([a-z_]+)\]/g;

function extractFindings(
  obj: Record<string, unknown>,
): Array<{ patternType: string; field: string }> {
  const out: Array<{ patternType: string; field: string }> = [];
  for (const f of FINDING_FIELDS) {
    const v = obj[f];
    if (typeof v !== "string" || v === "") continue;
    let m: RegExpExecArray | null;
    REDACTED_MARKER_RE.lastIndex = 0;
    while ((m = REDACTED_MARKER_RE.exec(v)) !== null) {
      out.push({ patternType: m[1]!, field: f });
    }
  }
  return out;
}

interface ParsedJsonl {
  traceRows: SQLQueryBindings[][];
  findingRows: SQLQueryBindings[][];
}

function parseJsonlForTraces(file: string): ParsedJsonl {
  const content = readFileSync(file, "utf-8");
  const traceRows: SQLQueryBindings[][] = [];
  const findingRows: SQLQueryBindings[][] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    traceRows.push([
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
    for (const finding of extractFindings(obj)) {
      findingRows.push([
        asText(obj.timestamp),
        asText(obj.agent),
        asText(obj.sessionId),
        asText(obj.project),
        finding.patternType,
        asText(obj.id),
        finding.field,
      ]);
    }
  }
  return { traceRows, findingRows };
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
