import { query, type SQLQueryBindings } from "./db";

/**
 * Query layer over the SQLite tables built in ./db.ts. Conventions:
 * - timestamps are stored as ISO TEXT; aggregate via date()/strftime().
 * - tokenUsage is a JSON text column; access via json_extract().
 * - Boolean-ish columns (agentAuthored) are 0/1 INTEGER.
 * - Array columns (files, parentShas, coAuthors) are JSON text.
 */

export interface Filters {
  days?: number;
  project?: string;
  model?: string;
  tool?: string;
  agent?: string;
  granularity?: "day" | "week" | "month";
  /** Single calendar day in YYYY-MM-DD form. When set, overrides `days`
   *  — used by the leaks page's click-to-drill on the chart. */
  date?: string;
}

/** Date bucket expression keyed off the timestamp text column. */
function dateTrunc(f: Filters, col = "timestamp"): string {
  switch (f.granularity) {
    // SQLite doesn't have DATE_TRUNC. ISO weeks start Monday — `weekday 1`
    // jumps forward to Monday, then -7 anchors to the prior Monday.
    case "week":  return `date(${col}, 'weekday 1', '-7 days')`;
    case "month": return `strftime('%Y-%m-01', ${col})`;
    default:      return `date(${col})`;
  }
}

/**
 * String-quote helper retained ONLY for cases where we interpolate
 * a closed-set string constant — e.g. building an IN-list of tool
 * names from the compile-time EDIT_TOOL_NAMES / READ_TOOL_NAMES /
 * validation-prefix arrays. NEVER pass user input here; bind via `?`
 * placeholders (see OBS-023, 2026-05 review).
 */
function escConstant(s: string): string {
  return s.replace(/'/g, "''");
}

interface SQLFragment {
  sql: string;
  params: SQLQueryBindings[];
}

/**
 * Tagged-template helper that runs a query with bind parameters.
 * Interpolating a string is treated as a literal SQL fragment (must
 * be a compile-time constant — see escConstant above). Interpolating
 * an SQLFragment merges its `?` placeholders into the surrounding
 * template and forwards its params positionally. Use this anywhere a
 * filter helper (where / securityWhere / gitWhere) is embedded.
 *
 * Example:
 *   const rows = await queryWhere<X>`
 *     SELECT ... FROM y ${where(f, ["extra"])} ORDER BY ...
 *   `;
 */
async function queryWhere<T = Record<string, unknown>>(
  template: TemplateStringsArray,
  ...values: (SQLFragment | string | number)[]
): Promise<T[]> {
  let sql = template[0] ?? "";
  const params: SQLQueryBindings[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v === "string" || typeof v === "number") {
      sql += String(v);
    } else if (v && typeof v === "object" && "sql" in v) {
      sql += v.sql;
      params.push(...v.params);
    }
    sql += template[i + 1] ?? "";
  }
  return query<T>(sql, params);
}

/**
 * Build a WHERE clause from common filters. Returns both the SQL
 * fragment (with `?` placeholders) and the matching positional
 * params array. Manual string-concat of `f.project`, `f.agent`, etc.
 * used to live here — every new filter was one forgotten `esc()`
 * away from injection on any non-loopback bind (OBS-023).
 */
/** Small helper: build a "?" placeholder bound to a single value.
 *  Use inside a queryWhere`...` template to inject a user-controlled
 *  scalar (sessionId, sha, tool name from URL, …) without string
 *  concatenation. */
function bind(value: SQLQueryBindings): SQLFragment {
  return { sql: "?", params: [value] };
}

/** Build an IN-list of bind placeholders for an array of scalars. */
function bindList(values: readonly SQLQueryBindings[]): SQLFragment {
  return {
    sql: values.length === 0 ? "(NULL)" : `(${values.map(() => "?").join(",")})`,
    params: [...values],
  };
}

function where(f: Filters, extra?: (string | SQLFragment)[]): SQLFragment {
  const conds: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (extra) {
    for (const e of extra) {
      if (typeof e === "string") conds.push(e);
      else { conds.push(e.sql); params.push(...e.params); }
    }
  }
  conds.push(`timestamp IS NOT NULL`);
  if (f.days)    conds.push(`timestamp >= date('now', '-${Number(f.days)} days')`);
  if (f.project) { conds.push(`project = ?`); params.push(f.project); }
  if (f.model)   { conds.push(`model = ?`); params.push(f.model); }
  if (f.tool) {
    // Sentinel "*mcp" filters across all MCP tools regardless of naming
    // convention (Claude Code emits `mcp:server:tool`, the API uses
    // `mcp__server__tool`). Anything else is treated as an exact match.
    if (f.tool === "*mcp") {
      conds.push(`(toolName LIKE 'mcp:%' OR toolName LIKE 'mcp\\_\\_%' ESCAPE '\\')`);
    } else {
      conds.push(`toolName = ?`);
      params.push(f.tool);
    }
  }
  if (f.agent)   { conds.push(`agent = ?`); params.push(f.agent); }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

/** json_extract on tokenUsage — null-safe SUM helper. */
const TU_INPUT  = `json_extract(tokenUsage, '$.input')`;
const TU_OUTPUT = `json_extract(tokenUsage, '$.output')`;
const TU_CACHE_R = `json_extract(tokenUsage, '$.cacheRead')`;
const TU_CACHE_C = `json_extract(tokenUsage, '$.cacheCreation')`;

/** All tokens the model processed: input + output + cache reads + cache
 *  writes. Plain "input + output" undercounts caching agents by ~500x —
 *  Claude Code routes ~99% of its prompt tokens through cacheRead, so its
 *  raw input field is tiny while its actual model workload is huge.
 *  Including cache reads/writes makes the cross-agent comparison fair:
 *  every token here was shown to a model. */
const TU_TOTAL = `(COALESCE(${TU_INPUT},0) + COALESCE(${TU_OUTPUT},0) + COALESCE(${TU_CACHE_R},0) + COALESCE(${TU_CACHE_C},0))`;

// ── Stats ──────────────────────────────────────────────────────

export interface Stats {
  total_entries: number;
  total_sessions: number;
  total_projects: number;
  total_days: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_creation: number;
}

export async function getStats(f: Filters = {}): Promise<Stats> {
  const rows = await queryWhere<Stats>`
    SELECT
      COUNT(*)                          AS total_entries,
      COUNT(DISTINCT sessionId)         AS total_sessions,
      COUNT(DISTINCT project)           AS total_projects,
      COUNT(DISTINCT date(timestamp))   AS total_days,
      COALESCE(SUM(${TU_INPUT}), 0)     AS total_input_tokens,
      COALESCE(SUM(${TU_OUTPUT}), 0)    AS total_output_tokens,
      COALESCE(SUM(${TU_CACHE_R}), 0)   AS total_cache_read,
      COALESCE(SUM(${TU_CACHE_C}), 0)   AS total_cache_creation
    FROM traces
    ${where(f)}
  `;
  return rows[0];
}

// ── Activity ───────────────────────────────────────────────────

export interface ActivityRow {
  date: string;
  agent: string;
  count: number;
  total_tokens: number;
}

export async function getActivity(f: Filters = {}): Promise<ActivityRow[]> {
  return queryWhere<ActivityRow>`
    SELECT
      ${dateTrunc(f)} AS date,
      agent,
      COUNT(*) AS count,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f)}
    GROUP BY date, agent
    ORDER BY date
  `;
}

// ── Activity heatmap (date × project × agent) ────────────────

export interface HeatmapRow {
  date: string;
  project: string;
  agent: string;
  total_tokens: number;
}

/** Same filters and date granularity as the Activity Timeline; adds a
 *  `project` dimension so the dashboard can render a date×project matrix
 *  with per-cell agent breakdown. Drops null projects (rows we couldn't
 *  attribute to a workspace). */
export async function getHeatmap(f: Filters = {}): Promise<HeatmapRow[]> {
  return queryWhere<HeatmapRow>`
    SELECT
      ${dateTrunc(f)} AS date,
      project,
      agent,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f, ["project IS NOT NULL"])}
    GROUP BY date, project, agent
    ORDER BY date
  `;
}

// ── Tokens ─────────────────────────────────────────────────────

export interface TokenRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
}

export async function getTokens(f: Filters = {}): Promise<TokenRow[]> {
  return queryWhere<TokenRow>`
    SELECT
      ${dateTrunc(f)} AS date,
      COALESCE(SUM(${TU_INPUT}), 0)   AS input_tokens,
      COALESCE(SUM(${TU_OUTPUT}), 0)  AS output_tokens,
      COALESCE(SUM(${TU_CACHE_R}), 0) AS cache_read,
      COALESCE(SUM(${TU_CACHE_C}), 0) AS cache_creation
    FROM traces
    ${where(f, ["tokenUsage IS NOT NULL"])}
    GROUP BY date
    ORDER BY date
  `;
}

// ── Security findings ─────────────────────────────────────────
//
// The agent's secret scanner replaces matches with `[REDACTED:<type>]`
// markers in trace text. The dashboard's ingest scans every text field
// for these markers and writes one row per finding to
// security_findings (timestamp, agent, sessionId, project, patternType,
// sourceId, field). These queries aggregate over that table.
//
// We count markers, not raw secret matches — the agent already redacted
// the secret value. The marker IS the incident record.

export interface SecurityFindingRow {
  patternType: string;
  count: number;
  sessions: number;
  projects: number;
  agents: string[];
  firstAt: string;
  lastAt: string;
}

interface SecurityFindingRawRow extends Omit<SecurityFindingRow, "agents"> { agents: string }

/** Filter helper for security_findings — same shape as `where()` for traces,
 *  but the table doesn't have toolName/model so those filters are ignored. */
function securityWhere(f: Filters, extra?: (string | SQLFragment)[]): SQLFragment {
  const conds: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (extra) {
    for (const e of extra) {
      if (typeof e === "string") conds.push(e);
      else { conds.push(e.sql); params.push(...e.params); }
    }
  }
  conds.push(`timestamp IS NOT NULL`);
  // `date` (single calendar day) takes precedence over `days` (a window).
  // Used by the leaks page's chart click-to-drill — nonsense to combine.
  if (f.date) { conds.push(`date(timestamp) = ?`); params.push(f.date); }
  else if (f.days) conds.push(`timestamp >= date('now', '-${Number(f.days)} days')`);
  if (f.project) { conds.push(`project = ?`); params.push(f.project); }
  if (f.agent)   { conds.push(`agent = ?`); params.push(f.agent); }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

export async function getSecurityFindings(
  f: Filters = {},
  limit = 25,
): Promise<SecurityFindingRow[]> {
  const rows = await queryWhere<SecurityFindingRawRow>`
    SELECT
      patternType        AS patternType,
      COUNT(*)           AS count,
      COUNT(DISTINCT sessionId) AS sessions,
      COUNT(DISTINCT project)   AS projects,
      MIN(timestamp)     AS firstAt,
      MAX(timestamp)     AS lastAt,
      (SELECT json_group_array(a) FROM (
         SELECT DISTINCT agent AS a
         FROM security_findings sf2
         WHERE sf2.patternType = sf.patternType
       )) AS agents
    FROM security_findings sf
    ${securityWhere(f)}
    GROUP BY patternType
    ORDER BY count DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, agents: parseJsonArray(r.agents) }));
}

export interface SecurityTimelineRow {
  date: string;
  patternType: string;
  count: number;
}

/**
 * Per-(date, patternType) finding counts. The leaks chart pivots these
 * into a stacked bar chart — one bar per day, one segment per pattern.
 * Total for a day = sum of its rows.
 */
export async function getSecurityTimeline(f: Filters = {}): Promise<SecurityTimelineRow[]> {
  return queryWhere<SecurityTimelineRow>`
    SELECT
      ${dateTrunc(f)} AS date,
      patternType     AS patternType,
      COUNT(*)        AS count
    FROM security_findings
    ${securityWhere(f)}
    GROUP BY date, patternType
    ORDER BY date, patternType
  `;
}

export interface SecuritySessionRow {
  sessionId: string;
  agent: string;
  project: string | null;
  count: number;
  patterns: string[];
  firstAt: string;
  lastAt: string;
}

interface SecuritySessionRawRow extends Omit<SecuritySessionRow, "patterns"> { patterns: string }

export async function getSecuritySessions(
  f: Filters = {},
  limit = 50,
): Promise<SecuritySessionRow[]> {
  const rows = await queryWhere<SecuritySessionRawRow>`
    SELECT
      sessionId,
      MIN(agent)   AS agent,
      MAX(project) AS project,
      COUNT(*)     AS count,
      MIN(timestamp) AS firstAt,
      MAX(timestamp) AS lastAt,
      (SELECT json_group_array(p) FROM (
         SELECT DISTINCT patternType AS p
         FROM security_findings sf2
         WHERE sf2.sessionId = sf.sessionId
       )) AS patterns
    FROM security_findings sf
    ${securityWhere(f, ["sessionId IS NOT NULL"])}
    GROUP BY sessionId
    ORDER BY count DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, patterns: parseJsonArray(r.patterns) }));
}

// ── Permissions ───────────────────────────────────────────────
//
// What permissions does the agent actually need on this repo? Returns a
// categorized, frequency-ranked tree of (tool, command-prefix) pairs
// based on observed usage. Output is shaped so the UI can:
//   1. show "core / build / file / mcp" buckets the user can reason about
//   2. drill from verb (`git`) to subcommand (`git status`)
//   3. emit a Claude Code settings.json `permissions.allow` snippet
//
// Bash entries are produced at TWO depths:
//   depth=1: just the verb (e.g. ["Bash","git"]) — broader allow
//   depth=2: verb + subcommand (e.g. ["Bash","git","status"]) — narrower
// The UI lets the user check whichever granularity is right per command.

export type PermissionCategory = "core" | "build" | "file" | "mcp" | "other";

export interface PermissionRow {
  category: PermissionCategory;
  /** Top-level tool name (e.g., "Bash", "Read", "mcp:db-mcp:shell"). */
  tool: string;
  /** Path from root: ["Bash"], ["Bash","git"], ["Bash","git","status"], ["Read"]. */
  path: string[];
  count: number;
  sessions: number;
  /** Equivalent settings.json entry the user can copy if they pick this row. */
  allowlistEntry: string;
}

const CORE_VERBS = new Set([
  "git", "grep", "rg", "find", "ls", "cat", "head", "tail",
  "sed", "awk", "mv", "cp", "ln", "chmod", "mkdir", "rm",
  "cd", "pwd", "echo", "diff", "tee", "tr", "cut", "sort", "uniq",
  "xargs", "wc", "tar", "gzip", "gunzip", "curl", "wget",
]);

const BUILD_VERBS = new Set([
  "bun", "npm", "yarn", "pnpm", "uv", "pip", "poetry", "cargo",
  "go", "gradle", "mvn", "maven", "make", "just", "dotnet",
  "ruff", "mypy", "pytest", "jest", "vitest", "bunx", "npx",
  "tsc", "eslint", "prettier", "rustc", "rustup", "cmake",
]);

const FILE_TOOLS = new Set([
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep",
]);

function classifyVerb(verb: string): PermissionCategory {
  if (CORE_VERBS.has(verb)) return "core";
  if (BUILD_VERBS.has(verb)) return "build";
  return "other";
}

function classifyTool(toolName: string): PermissionCategory {
  if (FILE_TOOLS.has(toolName)) return "file";
  if (toolName.startsWith("mcp:") || toolName.startsWith("mcp__")) return "mcp";
  return "other";
}

interface PermRawRow {
  toolName: string;
  command: string | null;
  sessionId: string | null;
}

export async function getPermissions(f: Filters = {}): Promise<PermissionRow[]> {
  const rows = await queryWhere<PermRawRow>`
    SELECT toolName, command, sessionId
    FROM traces
    ${where(f, ["entryType = 'tool_call'", "toolName IS NOT NULL"])}
  `;

  // Aggregate counts + distinct sessions per (tool, path) pair.
  type Bucket = { tool: string; path: string[]; count: number; sessions: Set<string> };
  const buckets = new Map<string, Bucket>();
  const bump = (tool: string, path: string[], sessionId: string | null) => {
    const key = `${tool}\t${path.join("\t")}`;
    let b = buckets.get(key);
    if (!b) {
      b = { tool, path, count: 0, sessions: new Set() };
      buckets.set(key, b);
    }
    b.count += 1;
    if (sessionId) b.sessions.add(sessionId);
  };

  for (const r of rows) {
    const tool = normalizeToolName(r.toolName);
    if (tool === "Bash" || tool === "Shell") {
      // Bash / codex `shell` → tokenize the command, strip leading
      // env-var assignments and flags, then take the first real verb.
      // Skip the row entirely if any extracted token contains shell
      // metacharacters that would produce invalid allowlist syntax
      // (mismatched parens, $() / backtick subshells, etc.).
      if (!r.command) continue;
      const verb = extractBashVerb(r.command);
      if (!verb) continue;
      bump(tool, [tool, verb.verb], r.sessionId);
      if (verb.sub) bump(tool, [tool, verb.verb, verb.sub], r.sessionId);
    } else {
      bump(tool, [tool], r.sessionId);
    }
  }

  return [...buckets.values()]
    .map((b) => {
      let category: PermissionCategory;
      if (b.tool === "Bash" || b.tool === "Shell") {
        const verb = b.path[1] ?? "";
        category = classifyVerb(verb);
      } else {
        category = classifyTool(b.tool);
      }
      return {
        category,
        tool: b.tool,
        path: b.path,
        count: b.count,
        sessions: b.sessions.size,
        allowlistEntry: toAllowlistEntry(b.tool, b.path),
      };
    })
    .sort((a, b) =>
      a.category.localeCompare(b.category) ||
      b.count - a.count ||
      a.path.length - b.path.length,
    );
}

/** Format a tool/path pair as a Claude Code `permissions.allow` entry. */
function toAllowlistEntry(tool: string, path: string[]): string {
  if (tool === "Bash" || tool === "Shell") {
    const prefix = path.slice(1).join(" ");
    return `${tool}(${prefix}:*)`;
  }
  return tool;
}

/**
 * Claude Code's settings.json grammar requires PascalCase tool names
 * (Bash, Shell, Read, Stdin, …). MCP names — both the `mcp:server:tool`
 * and `mcp__server__tool` forms — are documented exceptions and stay
 * verbatim. Everything else gets its first letter uppercased.
 */
function normalizeToolName(tool: string): string {
  if (tool.startsWith("mcp:") || tool.startsWith("mcp__")) return tool;
  if (!tool) return tool;
  const first = tool[0]!;
  if (first >= "A" && first <= "Z") return tool;
  return first.toUpperCase() + tool.slice(1);
}

/**
 * Extract a stable (verb, subcommand?) pair from a bash command string.
 * Returns null when the command can't be turned into a clean allowlist
 * entry — e.g. `PID=$(lsof -ti :3000)` (mismatched parens once wrapped),
 * or pipelines / subshells we can't model.
 *
 * Rules:
 * 1. Tokenize on whitespace.
 * 2. Strip leading env-var assignments (`KEY=value` shape) so
 *    `LC_ALL=C bun test` resolves to verb `bun`, not `LC_ALL=C`.
 * 3. Skip flag tokens (`-f`, `--flag`).
 * 4. Reject anything that contains shell metacharacters — they can't
 *    be safely embedded in a `Bash(verb:*)` rule.
 */
function extractBashVerb(command: string): { verb: string; sub?: string } | null {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  // Skip leading env-var assignments. POSIX requires `[A-Z_][A-Z0-9_]*=`
  // but we accept the slightly broader programmer convention.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  // Skip leading flags (rare but possible after env strip).
  while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
  const verb = tokens[i];
  if (!verb || !isCleanVerb(verb)) return null;
  // The subcommand is the next non-flag token, again clean.
  let j = i + 1;
  while (j < tokens.length && tokens[j]!.startsWith("-")) j++;
  const sub = tokens[j];
  if (sub && !isCleanVerb(sub)) return { verb };
  return sub ? { verb, sub } : { verb };
}

/**
 * A token is safe to embed in `Bash(token:*)` only when it's free of
 * shell metacharacters. We reject anything Claude Code's parser would
 * choke on or that would produce a misleading rule.
 */
function isCleanVerb(token: string): boolean {
  // Conservative: ASCII letters, digits, plus the few harmless punctuation
  // chars that show up in real verbs (`/` for paths-as-verbs, `.` for
  // `./script`, `_`, `-`). Anything else means metachar / quoting trouble.
  return /^[A-Za-z0-9_./+-]+$/.test(token);
}

// ── Tools ──────────────────────────────────────────────────────

export interface ToolRow {
  tool_name: string;
  count: number;
  primary_agent: string;
  agents: string[];
}

interface ToolRowRaw extends Omit<ToolRow, "agents"> { agents: string }

/**
 * Tools roll-up. SQLite has no MODE / LIST, so:
 * - primary_agent: most-frequent agent for this tool, via window-style subquery.
 * - agents: json_group_array(DISTINCT agent), parsed back to an array client-side.
 */
export async function getTools(f: Filters = {}, limit = 25): Promise<ToolRow[]> {
  const rows = await queryWhere<ToolRowRaw>`
    SELECT
      toolName AS tool_name,
      COUNT(*) AS count,
      (
        SELECT agent FROM traces t2
        WHERE t2.toolName = t.toolName
        GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1
      ) AS primary_agent,
      (
        SELECT json_group_array(a) FROM (
          SELECT DISTINCT agent AS a FROM traces t3 WHERE t3.toolName = t.toolName
        )
      ) AS agents
    FROM traces t
    ${where(f, ["toolName IS NOT NULL"])}
    GROUP BY toolName
    ORDER BY count DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, agents: parseJsonArray(r.agents) }));
}

// ── Motifs (parked) ────────────────────────────────────────────
//
// Cross-session (tool, first-arg-word) frequency leaderboard.
// Parked 2026-04-28 because the aggregation was too coarse to be
// actionable: "Bash cd 1209×" or "Edit .ts 963×" tell you nothing
// about what the agent actually did wrong. Replaced by `getStumbles`
// below, which keys on per-session repetition of the *full* normalized
// command — surfacing concrete loops like "agent ran the same db-mcp
// query 14× in 30 min" that a human can act on.
//
// Function and unit test kept for now in case we re-wire it (e.g. as a
// "popular tools" sidebar). Drop entirely if it stays unused for a few
// releases.

export interface MotifRow {
  toolName: string;
  shape: string;
  occurrences: number;
  sessions: number;
  tokens: number;
}

interface MotifRawRow {
  toolName: string;
  command: string | null;
  filePath: string | null;
  sessionId: string | null;
  tokens: number;
}

/** Reduce a tool call's argument to a coarse "shape" token. */
function motifShape(toolName: string, command: string | null, filePath: string | null): string {
  if (toolName === "Bash" && command) {
    // First whitespace-separated word of the command — `grep -r foo`
    // and `grep -n bar` share the shape "grep".
    const m = command.trimStart().match(/^[^\s]+/);
    return m ? m[0] : "";
  }
  if (filePath) {
    // File extension if present (".ts"); otherwise empty so unrelated
    // paths don't all collapse to one bucket.
    const dot = filePath.lastIndexOf(".");
    const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    if (dot > slash && dot < filePath.length - 1) return filePath.slice(dot);
  }
  return "";
}

export async function getMotifs(f: Filters = {}, limit = 25): Promise<MotifRow[]> {
  const rows = await queryWhere<MotifRawRow>`
    SELECT
      toolName,
      command,
      filePath,
      sessionId,
      ${TU_TOTAL} AS tokens
    FROM traces
    ${where(f, ["entryType = 'tool_call'", "toolName IS NOT NULL"])}
  `;

  type Bucket = { toolName: string; shape: string; occurrences: number; sessions: Set<string>; tokens: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const shape = motifShape(r.toolName, r.command, r.filePath);
    const key = `${r.toolName}\t${shape}`;
    let b = buckets.get(key);
    if (!b) {
      b = { toolName: r.toolName, shape, occurrences: 0, sessions: new Set(), tokens: 0 };
      buckets.set(key, b);
    }
    b.occurrences += 1;
    if (r.sessionId) b.sessions.add(r.sessionId);
    b.tokens += Number(r.tokens) || 0;
  }

  // Drop singletons — by definition a motif is something repeated.
  return [...buckets.values()]
    .filter((b) => b.occurrences >= 2)
    .map((b) => ({ toolName: b.toolName, shape: b.shape, occurrences: b.occurrences, sessions: b.sessions.size, tokens: b.tokens }))
    .sort((a, b) => b.occurrences - a.occurrences || b.tokens - a.tokens)
    .slice(0, limit);
}

// ── Incidents ──────────────────────────────────────────────────
//
// Per-session redundant-loop detector. Groups tool calls by
// (sessionId, toolName, normalized-args) and surfaces clusters where
// the same normalized invocation occurred ≥3 times in one session.
//
// Why per-session, not cross-session: cross-session totals just tell
// you which tools the agent uses a lot ("Bash cd 1209×") — that is
// not actionable. Within-session repetition catches the failure mode
// the user actually pays for: agent stuck in a loop, poking the same
// thing over and over instead of stepping back. db-mcp shell-spam,
// `git status` hammering, MCP query loops surface automatically.
//
// File-iteration tools (Read/Edit/Write/MultiEdit/NotebookEdit) are
// excluded by design. Editing the same file 50 times in one session
// is just "iterative coding" — it's how editors work; calling it a
// "loop" produces noise that drowns out the actual stuck patterns
// (MCP queries, search probes, web fetches).

const ITERATION_TOOLS = new Set([
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit",
]);

export interface StumbleRow {
  sessionId: string;
  agent: string;
  project: string | null;
  toolName: string;
  shape: string;
  occurrences: number;
  tokens: number;          // tokens attributed to this loop's tool_call rows
  sessionTokens: number;   // total tokens across the session — the cost frame
  firstAt: string;
  lastAt: string;
}

interface StumbleRawRow {
  sessionId: string;
  agent: string;
  project: string | null;
  toolName: string;
  command: string | null;
  filePath: string | null;
  timestamp: string;
  tokens: number;
}

/**
 * Reduce a tool call's args to a "shape" that clusters near-duplicate
 * invocations. Keep the verbatim command/path so the user sees the
 * actual thing the agent kept doing; only collapse the parts that
 * vary across runs (paths, quoted strings) so `grep foo /a/b` and
 * `grep foo /c/d` count as the same loop.
 */
function incidentShape(_toolName: string, command: string | null, filePath: string | null): string {
  // A `command` field exists for Bash and for any MCP tool that surfaces
  // its primary argument as a command-like string (db-mcp shell, etc.).
  if (command) {
    return command
      .trim()
      .replace(/'[^']*'/g, "<str>")
      .replace(/"[^"]*"/g, "<str>")
      .replace(/\S*[/.][^\s]*/g, "<path>")    // anything containing / or .
      .replace(/\s+/g, " ");
  }
  if (filePath) return filePath;
  return "";
}

export async function getStumbles(f: Filters = {}, limit = 25): Promise<StumbleRow[]> {
  const rows = await queryWhere<StumbleRawRow>`
    SELECT
      sessionId,
      agent,
      project,
      toolName,
      command,
      filePath,
      timestamp,
      ${TU_TOTAL} AS tokens
    FROM traces
    ${where(f, ["entryType = 'tool_call'", "toolName IS NOT NULL", "sessionId IS NOT NULL"])}
  `;

  // Session-wide totals come from message rows (where codex attributes its
  // tokens), not just the tool_call rows. We pull this in a second query so
  // the per-incident bucketing stays simple. Sessions outside the filter
  // window are skipped — the JOIN-equivalent here is the lookup map.
  const sessionTokenRows = await queryWhere<{ sessionId: string; total: number }>`
    SELECT sessionId, SUM(${TU_TOTAL}) AS total
    FROM traces
    ${where(f, ["sessionId IS NOT NULL"])}
    GROUP BY sessionId
  `;
  const sessionTokens = new Map<string, number>();
  for (const r of sessionTokenRows) sessionTokens.set(r.sessionId, Number(r.total) || 0);

  type Bucket = {
    sessionId: string; agent: string; project: string | null;
    toolName: string; shape: string;
    occurrences: number; tokens: number;
    firstAt: string; lastAt: string;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (ITERATION_TOOLS.has(r.toolName)) continue;
    const shape = incidentShape(r.toolName, r.command, r.filePath);
    if (!shape) continue;            // skip rows where we have no usable arg signal
    const key = `${r.sessionId}\t${r.toolName}\t${shape}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        sessionId: r.sessionId, agent: r.agent, project: r.project,
        toolName: r.toolName, shape,
        occurrences: 0, tokens: 0,
        firstAt: r.timestamp, lastAt: r.timestamp,
      };
      buckets.set(key, b);
    }
    b.occurrences += 1;
    b.tokens += Number(r.tokens) || 0;
    if (r.timestamp < b.firstAt) b.firstAt = r.timestamp;
    if (r.timestamp > b.lastAt) b.lastAt = r.timestamp;
  }

  return [...buckets.values()]
    .filter((b) => b.occurrences >= 3)
    .map((b) => ({ ...b, sessionTokens: sessionTokens.get(b.sessionId) ?? 0 }))
    .sort((a, b) => b.occurrences - a.occurrences || b.sessionTokens - a.sessionTokens)
    .slice(0, limit);
}

// ── Dark spend ─────────────────────────────────────────────────
//
// Sessions where the agent burned tokens disproportionately to its
// observable output. Two failure modes get one ranking: agent that
// flailed and committed nothing (commits=0 → ratio = tokens), and
// agent that produced something tiny for huge cost (1M tokens for
// 5 LoC). Both surface as outliers when sorted by tokens/max(LoC, 1).
//
// Why this complements `getStumbles`: incidents catches per-session
// repetition (agent stuck in a loop). Dark spend catches the broader
// failure where the session may not loop visibly but still burned a
// pile of tokens for nothing.

export interface DarkSpendRow {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  /** Active wall time (ms) — first/last minus gaps over 5min, like the
   *  session detail page's metric. Wall (ended-started) is misleading
   *  for sessions reused intermittently across days. */
  activeMs: number;
  tokens: number;
  commits: number;
  locDelta: number;
  tokensPerLoc: number;
}

/**
 * Pull every session in the filter window with its token totals, commit
 * count, LoC delta, and active time. Used by both getDarkSpend (sessions
 * that shipped code) and getZeroCode (sessions that shipped nothing) —
 * each adds its own filter and sort on top.
 */
async function sessionRollups(f: Filters): Promise<DarkSpendRow[]> {
  const sessionRows = await queryWhere<{
    sessionId: string; agent: string; project: string | null;
    started: string; ended: string; tokens: number;
  }>`
    SELECT
      sessionId,
      MIN(agent) AS agent,
      MAX(project) AS project,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
      COALESCE(SUM(${TU_TOTAL}), 0) AS tokens
    FROM traces
    ${where(f, ["sessionId IS NOT NULL"])}
    GROUP BY sessionId
  `;

  // Only agent-authored commits count toward session metrics. A
  // human commit can land with sessionId set (e.g. through a
  // backfill heuristic, or — historically — the now-fixed bug that
  // promoted any in-window orphan to agentAuthored=1). The session
  // rollup powers dark-spend / zero-code, where the question is
  // "how productive was the agent" — credit for human-author LoC
  // would silently flatter the ratio.
  const gitRows = await query<{ sessionId: string; commits: number; loc: number }>(`
    SELECT
      sessionId,
      COUNT(*) AS commits,
      COALESCE(SUM(COALESCE(insertions, 0) + COALESCE(deletions, 0)), 0) AS loc
    FROM git_events
    WHERE eventType = 'commit' AND sessionId IS NOT NULL AND agentAuthored = 1
    GROUP BY sessionId
  `);
  const gitBySession = new Map<string, { commits: number; loc: number }>();
  for (const r of gitRows) gitBySession.set(r.sessionId, { commits: Number(r.commits), loc: Number(r.loc) });

  // Per-session timestamps for active-time computation (wall minus gaps
  // > 5 min). Sessions reused across days otherwise look multi-day.
  const tsRows = await queryWhere<{ sessionId: string; timestamp: string }>`
    SELECT sessionId, timestamp
    FROM traces
    ${where(f, ["sessionId IS NOT NULL"])}
    ORDER BY sessionId, timestamp
  `;
  const tsBySession = new Map<string, string[]>();
  for (const r of tsRows) {
    let arr = tsBySession.get(r.sessionId);
    if (!arr) { arr = []; tsBySession.set(r.sessionId, arr); }
    arr.push(r.timestamp);
  }

  return sessionRows.map((s) => {
    const g = gitBySession.get(s.sessionId);
    const commits = g?.commits ?? 0;
    const locDelta = g?.loc ?? 0;
    const tokens = Number(s.tokens) || 0;
    const tokensPerLoc = tokens / Math.max(locDelta, 1);
    const { active_ms } = computeActivityProfile(
      tsBySession.get(s.sessionId) ?? [],
      s.started, s.ended,
    );
    return {
      sessionId: s.sessionId, agent: s.agent, project: s.project,
      started: s.started, ended: s.ended,
      activeMs: active_ms,
      tokens, commits, locDelta, tokensPerLoc,
    };
  });
}

/** Sessions that shipped code but burned tokens to do it. LoC > 0 only. */
export async function getDarkSpend(f: Filters = {}, limit = 50): Promise<DarkSpendRow[]> {
  const rows = await sessionRollups(f);
  return rows
    .filter((r) => r.locDelta > 0)
    .sort((a, b) => b.tokensPerLoc - a.tokensPerLoc)
    .slice(0, limit);
}

/**
 * Sessions that produced zero LoC. Includes legitimate non-code work
 * (data analysis, exploration) AND pure flail — the dashboard description
 * tells the user to mentally separate them via the project filter.
 * Ranked by raw tokens since tokens/LoC is meaningless when LoC = 0.
 */
export async function getZeroCode(f: Filters = {}, limit = 50): Promise<DarkSpendRow[]> {
  const rows = await sessionRollups(f);
  return rows
    .filter((r) => r.locDelta === 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

// ── Validation coverage ───────────────────────────────────────

/**
 * Tool names that count as an "edit" — touching code in a way that
 * could plausibly need verification afterwards. Read/grep/list don't
 * count: they don't change anything to validate.
 */
const EDIT_TOOL_NAMES = new Set([
  "Edit", "Write", "MultiEdit",   // Claude Code
  "edit", "apply_patch",          // Codex (parser normalizes apply_patch → edit)
  "edit_file", "create_file",     // Cursor / future
]);

/**
 * Command-prefix patterns that count as a validation invocation when
 * fired through a Bash/shell tool call. Hard-coded for v1 — making
 * this config-driven (so a project can add `make check`, `tox`, etc.)
 * is a follow-up. Patterns match LIKE-prefix style; `command` is
 * truncated to 200 chars by the parser, so anchoring at the start is
 * the only reliable shape.
 */
const VALIDATION_COMMAND_PATTERNS: string[] = [
  // bun
  "bun test%", "bun run test%", "bun run lint%", "bun run typecheck%",
  "bun run type-check%", "bun run build%", "bun run e2e%", "bunx playwright%",
  "bunx vitest%", "bunx tsc%", "bunx eslint%",
  // npm / yarn / pnpm
  "npm test%", "npm run test%", "npm run lint%", "npm run typecheck%",
  "npm run type-check%", "npm run build%", "npm run e2e%",
  "yarn test%", "yarn run test%", "yarn lint%", "yarn typecheck%", "yarn build%",
  "pnpm test%", "pnpm run test%", "pnpm lint%", "pnpm typecheck%", "pnpm build%",
  // Direct test runners
  "pytest%", "vitest%", "jest%", "playwright%",
  "tsc%", "eslint%", "ruff%", "mypy%", "flake8%", "black --check%",
  "cargo test%", "cargo build%", "cargo clippy%", "cargo check%",
  "go test%", "go build%", "go vet%",
  // make / just shorthands
  "make test%", "make lint%", "make check%", "make build%",
  "just test%", "just lint%", "just check%",
];

export interface ValidationCoverageRow {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  tokens: number;
  /** Latest edit-shaped tool call timestamp. Always set on returned rows. */
  lastEditAt: string;
  /** Latest validation-shaped tool call timestamp. Null if the session
   *  never ran tests / lint / typecheck / build. */
  lastValidationAt: string | null;
  /** True iff lastValidationAt > lastEditAt — i.e. the agent verified
   *  its work AFTER the last code change. */
  validatedAfterEdit: boolean;
}

/**
 * "Did the agent verify its own work before finishing?" per session.
 *
 * Returns one row per session that edited code at least once. Sorted
 * by un-validated sessions first (validatedAfterEdit=false), then by
 * tokens descending — so the most expensive flail surfaces at the
 * top, which is what the page is built to highlight.
 *
 * Edit detection: tool_call with toolName in EDIT_TOOL_NAMES.
 * Validation detection: Bash/shell tool_call whose `command` matches
 * a VALIDATION_COMMAND_PATTERNS prefix.
 */
export async function getValidationCoverage(
  f: Filters = {},
): Promise<ValidationCoverageRow[]> {
  const editToolList = [...EDIT_TOOL_NAMES].map((t) => `'${escConstant(t)}'`).join(", ");
  const cmdLikeClause = VALIDATION_COMMAND_PATTERNS
    .map((p) => `command LIKE '${escConstant(p)}'`)
    .join(" OR ");

  const rows = await queryWhere<{
    sessionId: string; agent: string; project: string | null;
    started: string; ended: string;
    tokens: number;
    lastEditAt: string;
    lastValidationAt: string | null;
  }>`
    WITH edits AS (
      SELECT sessionId, MAX(timestamp) AS lastEditAt
      FROM traces
      ${where(f, [`entryType = 'tool_call'`, `toolName IN (${editToolList})`])}
      GROUP BY sessionId
    ),
    validations AS (
      SELECT sessionId, MAX(timestamp) AS lastValidationAt
      FROM traces
      ${where(f, [
        `entryType = 'tool_call'`,
        `(toolName = 'Bash' OR toolName = 'shell')`,
        `command IS NOT NULL`,
        `(${cmdLikeClause})`,
      ])}
      GROUP BY sessionId
    ),
    sessions AS (
      SELECT
        sessionId,
        MIN(agent)     AS agent,
        MAX(project)   AS project,
        MIN(timestamp) AS started,
        MAX(timestamp) AS ended,
        COALESCE(SUM(${TU_TOTAL}), 0) AS tokens
      FROM traces
      ${where(f, [`sessionId IS NOT NULL`])}
      GROUP BY sessionId
    )
    SELECT
      s.sessionId, s.agent, s.project, s.started, s.ended, s.tokens,
      e.lastEditAt, v.lastValidationAt
    FROM edits e
    JOIN sessions s USING (sessionId)
    LEFT JOIN validations v USING (sessionId)
  `;

  return rows
    .map((r) => ({
      ...r,
      tokens: Number(r.tokens),
      validatedAfterEdit:
        r.lastValidationAt !== null && r.lastValidationAt > r.lastEditAt,
    }))
    .sort((a, b) => {
      // Un-validated first; among those, expensive first.
      if (a.validatedAfterEdit !== b.validatedAfterEdit) {
        return a.validatedAfterEdit ? 1 : -1;
      }
      return b.tokens - a.tokens;
    });
}

// ── Validation loops (stuck-agent detector) ────────────────────

export interface ValidationLoopRow {
  sessionId: string;
  agent: string;
  project: string | null;
  command: string;
  /** How many times this validation command ran in the session. */
  attempts: number;
  /** How many of those linked to a tool_result with success=false. */
  failures: number;
  /** Wall-clock window of the loop (first call → last result). */
  startedAt: string;
  endedAt: string;
}

const VALIDATION_LOOP_THRESHOLD = 3;

/**
 * Find "stuck agent" loops: same validation command (test / lint /
 * typecheck / build) running again and again in one session, often
 * with the same failures repeating. Different shape from generic
 * stumbles — those flag any repeated tool call; this requires the
 * call to be a validation invocation, and we report failure count
 * separately so the user can tell "thrashing" from "running the
 * suite twice on purpose".
 *
 * Failures derive from PR #25's `success` column on tool_result
 * rows, joined to the tool_call by `toolCallId`. Rows surface only
 * when attempts >= VALIDATION_LOOP_THRESHOLD; sort by failures desc,
 * then attempts desc — the most stuck loops at the top.
 */
export async function getValidationLoops(
  f: Filters = {},
): Promise<ValidationLoopRow[]> {
  const cmdLikeClause = VALIDATION_COMMAND_PATTERNS
    .map((p) => `command LIKE '${escConstant(p)}'`)
    .join(" OR ");

  return queryWhere<ValidationLoopRow>`
    WITH validation_calls AS (
      SELECT sessionId, MIN(agent) AS agent, MAX(project) AS project,
             toolCallId, command, MIN(timestamp) AS callAt
      FROM traces
      ${where(f, [
        `entryType = 'tool_call'`,
        `(toolName = 'Bash' OR toolName = 'shell')`,
        `command IS NOT NULL`,
        `toolCallId IS NOT NULL`,
        `(${cmdLikeClause})`,
      ])}
      GROUP BY sessionId, toolCallId, command
    ),
    -- Pick up the matching tool_result row for each call so we can
    -- read its success bit. Only one result per toolCallId, so a
    -- straight join is fine.
    results AS (
      SELECT toolCallId, success, MAX(timestamp) AS resultAt
      FROM traces
      WHERE entryType = 'tool_result' AND toolCallId IS NOT NULL
      GROUP BY toolCallId
    )
    SELECT
      v.sessionId, v.agent, v.project, v.command,
      COUNT(*) AS attempts,
      SUM(CASE WHEN r.success = 0 THEN 1 ELSE 0 END) AS failures,
      MIN(v.callAt) AS startedAt,
      COALESCE(MAX(r.resultAt), MAX(v.callAt)) AS endedAt
    FROM validation_calls v
    LEFT JOIN results r USING (toolCallId)
    GROUP BY v.sessionId, v.command
    HAVING COUNT(*) >= ${VALIDATION_LOOP_THRESHOLD}
    ORDER BY failures DESC, attempts DESC
  `;
}

// ── Intervention rate (autonomy) ───────────────────────────────

export interface InterventionRateRow {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  /** User-message turns — how often the human nudged the agent. */
  userTurns: number;
  /** All tool_call rows the agent fired in this session. */
  toolCalls: number;
  /** Agent-authored commits linked to this session. */
  commits: number;
  /** Sum of insertions + deletions across linked agent commits. */
  locDelta: number;
  tokens: number;
  /** Tools per user turn. High = autonomous (agent gets a lot done
   *  per nudge). Low = stalling / needs hand-holding. Always >= 0
   *  since userTurns > 0 by the query's contract. */
  toolsPerTurn: number;
  /** Turns per commit — null when no commits (no denominator). */
  turnsPerCommit: number | null;
  /** Turns per LoC delta — null when no LoC. */
  turnsPerLoc: number | null;
}

interface InterventionRateRaw {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  userTurns: number;
  toolCalls: number;
  commits: number;
  locDelta: number;
  tokens: number;
}

/**
 * Per-session "autonomy score" inputs. Counts user-turn messages
 * (how often the human nudged), tool_call rows the agent fired,
 * agent-authored commits + LoC linked to the session, and tokens.
 * Only sessions with >= 1 user turn appear — system-only sessions
 * carry no intervention signal.
 *
 * Sorted by userTurns descending so the most-interventional
 * sessions land at the top.
 */
export async function getInterventionRate(
  f: Filters = {},
): Promise<InterventionRateRow[]> {
  const rows = await queryWhere<InterventionRateRaw>`
    WITH user_turns AS (
      SELECT sessionId, COUNT(*) AS userTurns
      FROM traces
      ${where(f, [`entryType = 'message'`, `role = 'user'`, `sessionId IS NOT NULL`])}
      GROUP BY sessionId
      HAVING COUNT(*) > 0
    ),
    tool_calls AS (
      SELECT sessionId, COUNT(*) AS toolCalls
      FROM traces
      ${where(f, [`entryType = 'tool_call'`, `sessionId IS NOT NULL`])}
      GROUP BY sessionId
    ),
    sessions AS (
      SELECT
        sessionId,
        MIN(agent)     AS agent,
        MAX(project)   AS project,
        MIN(timestamp) AS started,
        MAX(timestamp) AS ended,
        COALESCE(SUM(${TU_TOTAL}), 0) AS tokens
      FROM traces
      ${where(f, [`sessionId IS NOT NULL`])}
      GROUP BY sessionId
    ),
    commits AS (
      SELECT sessionId,
             COUNT(*) AS commits,
             COALESCE(SUM(COALESCE(insertions, 0) + COALESCE(deletions, 0)), 0) AS locDelta
      FROM git_events
      WHERE eventType = 'commit'
        AND sessionId IS NOT NULL
        AND agentAuthored = 1
      GROUP BY sessionId
    )
    SELECT
      u.sessionId, s.agent, s.project, s.started, s.ended,
      u.userTurns,
      COALESCE(tc.toolCalls, 0) AS toolCalls,
      COALESCE(c.commits, 0)    AS commits,
      COALESCE(c.locDelta, 0)   AS locDelta,
      s.tokens
    FROM user_turns u
    JOIN sessions s ON s.sessionId = u.sessionId
    LEFT JOIN tool_calls tc ON tc.sessionId = u.sessionId
    LEFT JOIN commits c ON c.sessionId = u.sessionId
    ORDER BY u.userTurns DESC
  `;

  return rows.map((r) => {
    const tokens = Number(r.tokens);
    const userTurns = Number(r.userTurns);
    const toolCalls = Number(r.toolCalls);
    const commits = Number(r.commits);
    const locDelta = Number(r.locDelta);
    return {
      ...r,
      tokens,
      userTurns,
      toolCalls,
      commits,
      locDelta,
      toolsPerTurn: toolCalls / userTurns,
      turnsPerCommit: commits > 0 ? userTurns / commits : null,
      turnsPerLoc: locDelta > 0 ? userTurns / locDelta : null,
    };
  });
}

// ── Session efficiency: search-to-edit ratio + first-action latency ──

/**
 * Tool names that count as "reading" — looking around the codebase
 * without changing it. Bash/shell calls are also treated as reads
 * when the command starts with a known navigation verb (grep, find,
 * ls, cat, head, tail). The list is intentionally short — a long
 * tail of obscure shell tools isn't worth chasing for v1.
 */
const READ_TOOL_NAMES = new Set([
  "Read", "Glob", "Grep",                      // Claude Code
  "search", "grep", "list", "read",            // Cursor (post-normalization)
  "ToolSearch",
]);
const READ_COMMAND_PATTERNS: string[] = [
  "grep%", "rg %", "rg\t%",
  "find %", "find .%",
  "ls%", "cat %", "head %", "tail %", "less %", "more %",
  "git log%", "git show%", "git diff%", "git status%", "git blame%",
  "wc -l%",
];

export interface SearchToEditRow {
  sessionId: string;
  agent: string;
  project: string | null;
  reads: number;
  edits: number;
  ratio: number;
  started: string;
  ended: string;
  tokens: number;
}

/**
 * "Navigation friction" per session — high reads-per-edit means the
 * agent grep'd around a lot before making a small change. Filtered
 * to sessions with at least one edit; pure exploration sessions
 * don't have the signal we want.
 *
 * Read-detection covers both shape (toolName in READ_TOOL_NAMES)
 * AND a Bash/shell call whose command starts with a navigation verb,
 * because grep/find/ls fire as Bash calls in the live data, not as
 * dedicated read-tool primitives.
 */
export async function getSearchToEditRatio(
  f: Filters = {},
): Promise<SearchToEditRow[]> {
  const editToolList = [...EDIT_TOOL_NAMES].map((t) => `'${escConstant(t)}'`).join(", ");
  const readToolList = [...READ_TOOL_NAMES].map((t) => `'${escConstant(t)}'`).join(", ");
  const readCmdClause = READ_COMMAND_PATTERNS
    .map((p) => `command LIKE '${escConstant(p)}'`)
    .join(" OR ");

  const rows = await queryWhere<{
    sessionId: string; agent: string; project: string | null;
    reads: number; edits: number;
    started: string; ended: string; tokens: number;
  }>`
    WITH read_calls AS (
      SELECT sessionId, COUNT(*) AS reads
      FROM traces
      ${where(f, [
        `entryType = 'tool_call'`,
        `sessionId IS NOT NULL`,
        `(toolName IN (${readToolList})
          OR ((toolName = 'Bash' OR toolName = 'shell') AND command IS NOT NULL AND (${readCmdClause})))`,
      ])}
      GROUP BY sessionId
    ),
    edit_calls AS (
      SELECT sessionId, COUNT(*) AS edits
      FROM traces
      ${where(f, [
        `entryType = 'tool_call'`,
        `sessionId IS NOT NULL`,
        `toolName IN (${editToolList})`,
      ])}
      GROUP BY sessionId
      HAVING COUNT(*) > 0
    ),
    sessions AS (
      SELECT
        sessionId,
        MIN(agent)     AS agent,
        MAX(project)   AS project,
        MIN(timestamp) AS started,
        MAX(timestamp) AS ended,
        COALESCE(SUM(${TU_TOTAL}), 0) AS tokens
      FROM traces
      ${where(f, [`sessionId IS NOT NULL`])}
      GROUP BY sessionId
    )
    SELECT
      e.sessionId, s.agent, s.project,
      COALESCE(r.reads, 0) AS reads,
      e.edits,
      s.started, s.ended, s.tokens
    FROM edit_calls e
    JOIN sessions s ON s.sessionId = e.sessionId
    LEFT JOIN read_calls r ON r.sessionId = e.sessionId
  `;

  return rows
    .map((r) => ({ ...r, tokens: Number(r.tokens), ratio: Number(r.reads) / Number(r.edits) }))
    .sort((a, b) => b.ratio - a.ratio);
}

export interface FirstActionLatencyRow {
  sessionId: string;
  agent: string;
  project: string | null;
  /** First user message timestamp. */
  firstUserMsgAt: string;
  /** First edit / validation-shaped Bash / linked agent commit. */
  firstActionAt: string;
  latencyMs: number;
  tokens: number;
}

/**
 * Time between the first user message and the first useful action
 * (edit, validation Bash/shell call, or linked agent commit). Long
 * latencies = the agent over-explored before doing anything. Only
 * sessions with at least one such action appear; sessions that
 * never produced one carry no latency to measure.
 */
export async function getFirstActionLatency(
  f: Filters = {},
): Promise<FirstActionLatencyRow[]> {
  const editToolList = [...EDIT_TOOL_NAMES].map((t) => `'${escConstant(t)}'`).join(", ");
  const cmdLikeClause = VALIDATION_COMMAND_PATTERNS
    .map((p) => `command LIKE '${escConstant(p)}'`)
    .join(" OR ");

  const rows = await queryWhere<{
    sessionId: string; agent: string; project: string | null;
    firstUserMsgAt: string; firstActionAt: string;
    tokens: number;
  }>`
    WITH actions AS (
      -- "Useful action" = edit-shaped tool call OR validation
      -- Bash/shell call OR a linked agent commit. Treat all three
      -- via UNION ALL so MIN(timestamp) just works.
      SELECT sessionId, MIN(timestamp) AS firstActionAt FROM (
        SELECT sessionId, timestamp
        FROM traces
        ${where(f, [
          `entryType = 'tool_call'`,
          `sessionId IS NOT NULL`,
          `(toolName IN (${editToolList})
            OR ((toolName = 'Bash' OR toolName = 'shell') AND command IS NOT NULL AND (${cmdLikeClause})))`,
        ])}
        UNION ALL
        SELECT sessionId, timestamp
        FROM git_events
        WHERE eventType = 'commit'
          AND sessionId IS NOT NULL
          AND agentAuthored = 1
      )
      GROUP BY sessionId
    ),
    -- Use the LAST user message before the first action, not the
    -- first one in the session. Long-running sessions (Codex
    -- Desktop keeps a single conversation alive across days) have
    -- a first-msg timestamp from when the conversation started,
    -- but the action we're measuring was triggered by a much
    -- later prompt. "Last preceding prompt → action" captures the
    -- intent of the doc spec (over-exploration delay) without
    -- the multi-day false positives.
    user_msg AS (
      -- All user messages, then we constrain to those at-or-before
      -- the session's first action and pick the LAST one. Cleaner
      -- as a sub-SELECT than wedging a JOIN into the where() helper,
      -- which prepends an unaliased timestamp-IS-NOT-NULL filter.
      SELECT um.sessionId, MAX(um.timestamp) AS firstUserMsgAt
      FROM (
        SELECT sessionId, timestamp
        FROM traces
        ${where(f, [`entryType = 'message'`, `role = 'user'`, `sessionId IS NOT NULL`])}
      ) um
      JOIN actions a ON a.sessionId = um.sessionId
      WHERE um.timestamp <= a.firstActionAt
      GROUP BY um.sessionId
    ),
    sessions AS (
      SELECT
        sessionId,
        MIN(agent)     AS agent,
        MAX(project)   AS project,
        COALESCE(SUM(${TU_TOTAL}), 0) AS tokens
      FROM traces
      ${where(f, [`sessionId IS NOT NULL`])}
      GROUP BY sessionId
    )
    SELECT
      u.sessionId, s.agent, s.project,
      u.firstUserMsgAt, a.firstActionAt,
      s.tokens
    FROM user_msg u
    JOIN actions a USING (sessionId)
    JOIN sessions s USING (sessionId)
  `;

  // Cap at 2 hours. Beyond that, the latency reflects a session
  // resumed after a long gap, not the agent over-exploring before
  // acting — including those drags the page towards multi-day
  // outliers that aren't actionable as a quality signal. The
  // doc's motivating example was "20-60+ minutes," so 2h is
  // comfortably wider than the signal we want to catch.
  const MAX_LATENCY_MS = 2 * 60 * 60 * 1000;
  return rows
    .map((r) => {
      const latencyMs = new Date(r.firstActionAt).getTime() - new Date(r.firstUserMsgAt).getTime();
      return { ...r, tokens: Number(r.tokens), latencyMs };
    })
    .filter((r) => r.latencyMs >= 0 && r.latencyMs <= MAX_LATENCY_MS)
    .sort((a, b) => b.latencyMs - a.latencyMs);
}

// ── Productivity score (composite) ─────────────────────────────

export type ProductivityBucket =
  | "productive"
  | "expensive-but-productive"
  | "stuck"
  | "needs-better-setup";

export interface ProductivityScoreRow {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  tokens: number;
  // Inputs (one per upstream metric)
  commits: number;
  locDelta: number;
  userTurns: number;
  toolsPerTurn: number | null;
  validatedAfterEdit: boolean | null;
  stuckLoops: number;
  searchToEditRatio: number | null;
  firstActionMs: number | null;
  // Per-session red/green flags, with deterministic ordering.
  redFlags: string[];
  greenFlags: string[];
  bucket: ProductivityBucket;
  /** 0-100 composite score. Baseline 50, plus rewards for output
   *  (commits, LoC, validation) and penalties for friction
   *  (stuck loops, dark spend, high intervention, etc.). Useful for
   *  ranking within a bucket — the bucket is the headline, the score
   *  is the tiebreaker. */
  score: number;
}

/**
 * Composite per-session productivity score. Composes the outputs of
 * items #1-#7 into a per-session row with red/green quality flags
 * and a bucket label. Runs each upstream query independently and
 * joins by sessionId in TS — six small SQL passes are easier to
 * maintain than one monster query, and on the live data the total
 * latency is ~250ms.
 *
 * Filter: sessions that edited code OR committed. Pure-chat and
 * read-only exploration sessions don't have a quality signal worth
 * scoring; they'd just drown the page in zeros.
 *
 * Bucketing rubric (chosen to be interpretable, not optimal):
 *
 *   productive               commits ≥ 1 AND red flags ≤ 2
 *   expensive-but-productive commits ≥ 1 AND red flags ≥ 3
 *   stuck                    commits = 0 AND (stuck-loops ≥ 1 OR
 *                              dark-spend flag set)
 *   needs-better-setup       commits = 0, no stuck loops, but
 *                              ≥ 2 friction flags (search ratio,
 *                              intervention, latency)
 */
export async function getProductivityScore(
  f: Filters = {},
): Promise<ProductivityScoreRow[]> {
  // Run upstream queries in parallel. Each already respects
  // project/agent/days filters via the shared `where()` helper.
  const [rollups, validation, loops, intervention, searchToEdit, latency] =
    await Promise.all([
      sessionRollups(f),
      getValidationCoverage(f),
      getValidationLoops(f),
      getInterventionRate(f),
      getSearchToEditRatio(f),
      getFirstActionLatency(f),
    ]);

  // Index by sessionId for O(1) joins below.
  const validationBySession = new Map(validation.map((r) => [r.sessionId, r]));
  const interventionBySession = new Map(intervention.map((r) => [r.sessionId, r]));
  const ratioBySession = new Map(searchToEdit.map((r) => [r.sessionId, r]));
  const latencyBySession = new Map(latency.map((r) => [r.sessionId, r]));
  // Sum loop count per session (loops query returns one row per
  // (sessionId, command); rolling them up here gives a session-level
  // signal).
  const loopsBySession = new Map<string, number>();
  for (const l of loops) loopsBySession.set(l.sessionId, (loopsBySession.get(l.sessionId) ?? 0) + 1);

  // Anchor on sessionRollups (every session with traces). A session
  // is in-scope iff it committed OR appears in the validation
  // coverage table (which requires at least one edit).
  const rows: ProductivityScoreRow[] = [];
  for (const s of rollups) {
    const cov = validationBySession.get(s.sessionId);
    const hasEdit = cov !== undefined;
    if (!hasEdit && s.commits === 0) continue;   // pure exploration / chat

    const intRow = interventionBySession.get(s.sessionId);
    const ratioRow = ratioBySession.get(s.sessionId);
    const latRow = latencyBySession.get(s.sessionId);
    const stuckLoops = loopsBySession.get(s.sessionId) ?? 0;

    // Red flags. Thresholds picked to flag the long tails the
    // upstream pages already surface — staying consistent with
    // /validation, /autonomy, /efficiency etc.
    const redFlags: string[] = [];
    if (cov && cov.validatedAfterEdit === false) redFlags.push("no-validation");
    if (stuckLoops >= 1) redFlags.push("stuck-loops");
    if (intRow && intRow.userTurns >= 50) redFlags.push("high-intervention");
    if (ratioRow && ratioRow.ratio >= 5) redFlags.push("high-search-ratio");
    if (latRow && latRow.latencyMs >= 20 * 60 * 1000) redFlags.push("slow-first-action");
    // Dark-spend signature: lots of tokens, ≤ 5 LoC delivered.
    if (s.tokens >= 1_000_000 && s.locDelta <= 5) redFlags.push("dark-spend");

    const greenFlags: string[] = [];
    if (s.commits >= 1) greenFlags.push("shipped-commit");
    if (cov?.validatedAfterEdit === true) greenFlags.push("validated");

    // Composite score on a 0-100 scale. Baseline 50 + output
    // bonuses - friction penalties. Per-axis penalties are capped
    // so one bad axis (e.g. many stuck-test loops) can't bottom
    // out a session that otherwise shipped a lot of code. The
    // bucket below is derived from this score, so the two views
    // can't disagree by construction.
    let score = 50;
    score += Math.min(s.commits, 5) * 6;                  // up to +30
    score += Math.min(s.locDelta / 200, 8);               // up to +8
    if (cov?.validatedAfterEdit === true)  score += 10;
    if (cov?.validatedAfterEdit === false) score -= 8;
    score -= Math.min(stuckLoops * 8, 24);                // cap stuck penalty at -24
    if (intRow && intRow.userTurns >= 50) score -= 8;
    if (ratioRow && ratioRow.ratio >= 5)  score -= 6;
    if (latRow && latRow.latencyMs >= 20 * 60 * 1000) score -= 5;
    if (s.tokens >= 1_000_000 && s.locDelta <= 5) score -= 12;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Bucket assignment derived from score + structural signals.
    // The two-axis decision: (a) did the session ship code? — splits
    // productive variants from no-commit variants. (b) score —
    // splits clean shipping from expensive-shipping, and stuck-loop
    // sessions from generic friction.
    let bucket: ProductivityBucket;
    if (s.commits >= 1) {
      // A clean 1-commit + validation + no-friction session scores
      // 66 (50 + 6 + 10); 65 keeps that in "productive" while
      // pushing shipping-with-significant-friction below the line.
      bucket = score >= 65 ? "productive" : "expensive-but-productive";
    } else if (stuckLoops >= 1) {
      bucket = "stuck";
    } else {
      bucket = "needs-better-setup";
    }

    rows.push({
      sessionId: s.sessionId,
      agent: s.agent,
      project: s.project,
      started: s.started,
      ended: s.ended,
      tokens: s.tokens,
      commits: s.commits,
      locDelta: s.locDelta,
      userTurns: intRow?.userTurns ?? 0,
      toolsPerTurn: intRow?.toolsPerTurn ?? null,
      validatedAfterEdit: cov?.validatedAfterEdit ?? null,
      stuckLoops,
      searchToEditRatio: ratioRow?.ratio ?? null,
      firstActionMs: latRow?.latencyMs ?? null,
      redFlags,
      greenFlags,
      bucket,
      score,
    });
  }

  // Sort: productive sessions first by commits desc, then
  // expensive-but-productive, stuck, needs-better-setup. Within
  // each bucket, fewer red flags first (the cleanest examples).
  const bucketOrder: Record<ProductivityBucket, number> = {
    "productive": 0,
    "expensive-but-productive": 1,
    "stuck": 2,
    "needs-better-setup": 3,
  };
  rows.sort((a, b) => {
    if (a.bucket !== b.bucket) return bucketOrder[a.bucket] - bucketOrder[b.bucket];
    // Within a bucket: highest score first (cleanest examples at top).
    if (a.score !== b.score) return b.score - a.score;
    return b.tokens - a.tokens;
  });
  return rows;
}

// ── Projects ───────────────────────────────────────────────────

export interface ProjectRow {
  project: string;
  entries: number;
  sessions: number;
  output_tokens: number;
  total_tokens: number;
}

export async function getProjects(f: Filters = {}): Promise<ProjectRow[]> {
  return queryWhere<ProjectRow>`
    SELECT
      project,
      COUNT(*) AS entries,
      COUNT(DISTINCT sessionId) AS sessions,
      COALESCE(SUM(${TU_OUTPUT}), 0) AS output_tokens,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f, ["project IS NOT NULL"])}
    GROUP BY project
    ORDER BY total_tokens DESC
  `;
}

// ── Models ─────────────────────────────────────────────────────

export interface ModelRow {
  model: string;
  count: number;
  total_tokens: number;
}

export async function getModels(f: Filters = {}): Promise<ModelRow[]> {
  return queryWhere<ModelRow>`
    SELECT
      model,
      COUNT(*) AS count,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f, ["model IS NOT NULL"])}
    GROUP BY model
    ORDER BY total_tokens DESC
  `;
}

// ── Sessions ───────────────────────────────────────────────────

export interface SessionRow {
  session_id: string;
  agent: string;
  project: string;
  started: string;
  ended: string;
  entries: number;
  output_tokens: number;
}

export async function getSessions(f: Filters = {}, limit = 50): Promise<SessionRow[]> {
  // Tool/model filter restricts to sessions that contain a matching entry.
  const sessionFilter: (string | SQLFragment)[] = ["sessionId IS NOT NULL"];
  if (f.tool) {
    sessionFilter.push({
      sql: `sessionId IN (SELECT DISTINCT sessionId FROM traces WHERE toolName = ?)`,
      params: [f.tool],
    });
  }
  if (f.model) {
    sessionFilter.push({
      sql: `sessionId IN (SELECT DISTINCT sessionId FROM traces WHERE model = ?)`,
      params: [f.model],
    });
  }
  const sessFilter: Filters = { days: f.days, project: f.project, granularity: f.granularity };

  return queryWhere<SessionRow>`
    SELECT
      sessionId AS session_id,
      MIN(agent) AS agent,
      MIN(project) AS project,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
      COUNT(*) AS entries,
      COALESCE(SUM(${TU_OUTPUT}), 0) AS output_tokens
    FROM traces
    ${where(sessFilter, sessionFilter)}
    GROUP BY sessionId
    ORDER BY started DESC
    LIMIT ${limit}
  `;
}

// ── Tool detail (drill-down) ───────────────────────────────────

export interface ToolDetailRow {
  value: string;
  count: number;
}

export interface ToolDetail {
  tool: string;
  total: number;
  commands: ToolDetailRow[];
  files: ToolDetailRow[];
  timeline: { date: string; count: number }[];
  byAgent: { agent: string; count: number }[];
  projects: { project: string; count: number }[];
  models: { model: string; count: number }[];
}

export async function getToolDetail(tool: string, f: Filters = {}): Promise<ToolDetail> {
  const toolFrag: SQLFragment = { sql: "toolName = ?", params: [tool] };
  const w = where(f, [toolFrag]);

  const [totalRows, commands, files, timeline, byAgent, projects, models] = await Promise.all([
    query<{ total: number }>(`SELECT COUNT(*) AS total FROM traces ${w.sql}`, w.params),
    query<ToolDetailRow>(`
      SELECT command AS value, COUNT(*) AS count
      FROM traces ${w.sql} AND command IS NOT NULL
      GROUP BY command ORDER BY count DESC LIMIT 15
    `, w.params),
    query<ToolDetailRow>(`
      SELECT filePath AS value, COUNT(*) AS count
      FROM traces ${w.sql} AND filePath IS NOT NULL
      GROUP BY filePath ORDER BY count DESC LIMIT 15
    `, w.params),
    query<{ date: string; count: number }>(`
      SELECT ${dateTrunc(f)} AS date, COUNT(*) AS count
      FROM traces ${w.sql}
      GROUP BY date ORDER BY date
    `, w.params),
    query<{ agent: string; count: number }>(`
      SELECT agent, COUNT(*) AS count
      FROM traces ${w.sql}
      GROUP BY agent ORDER BY count DESC
    `, w.params),
    query<{ project: string; count: number }>(`
      SELECT project, COUNT(*) AS count
      FROM traces ${w.sql} AND project IS NOT NULL
      GROUP BY project ORDER BY count DESC
    `, w.params),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*) AS count
      FROM traces ${w.sql} AND model IS NOT NULL
      GROUP BY model ORDER BY count DESC
    `, w.params),
  ]);

  return {
    tool,
    total: totalRows[0]?.total ?? 0,
    commands,
    files,
    timeline,
    byAgent,
    projects,
    models,
  };
}

// ── Skills (user prompts starting with /) ──────────────────────

export interface SkillRow {
  skill: string;
  count: number;
}

export interface SkillUsageRow {
  /** Canonical name — no leading slash, no `skill:` prefix. */
  name: string;
  count: number;
  sessions: number;
  projects: number;
  firstSeen: string;
  lastSeen: string;
  /** Sorted distinct agents that fired this skill. Today only Claude
   *  Code has a Skill primitive, so this is effectively `["claude_code"]`
   *  in real data, but we surface it so the column makes sense if a
   *  future agent grows skill-style invocations. */
  agents: string[];
}

interface SkillUsageRaw {
  name: string;
  count: number;
  sessions: number;
  projects: number;
  firstSeen: string;
  lastSeen: string;
  agentsCsv: string | null;
}

/**
 * Per-skill usage powering the /skills page. Two sources are unioned
 * before grouping so a skill that's both typed (`/ship`) and invoked
 * by the model (`Skill(command="ship")`) collapses to a single row
 * with both sources flagged.
 *
 *   - slash: `traces.userPrompt LIKE '/%'` (entryType=message, role=user)
 *   - tool:  `traces.toolName  LIKE 'skill:%'` (entryType=tool_call)
 *
 * The agent normalizer (parsers/claude.ts) is what produces the
 * `skill:<name>` toolName from `Skill(command="...")` calls — Codex
 * doesn't fire skill: tool calls today, so the tool-source is
 * effectively Claude-Code-only until that changes.
 */
export async function getSkillUsage(f: Filters = {}): Promise<SkillUsageRow[]> {
  // Both sub-queries get the same project/agent/days filtering via where().
  // tool/model filters are intentionally not included — they don't make
  // sense for the skills page (every row is either a /-prompt message
  // or a `skill:*` tool call; filtering further would just zero things out).
  const baseFilters: Filters = {
    days: f.days,
    project: f.project,
    agent: f.agent,
  };

  const slashWhere = where(baseFilters, [
    `entryType = 'message'`,
    `role = 'user'`,
    `userPrompt IS NOT NULL`,
    `substr(trim(userPrompt), 1, 1) = '/'`,
    `length(trim(userPrompt)) > 1`,
  ]);

  const toolWhere = where(baseFilters, [
    `entryType = 'tool_call'`,
    `toolName LIKE 'skill:%'`,
    `length(toolName) > 6`,
  ]);

  const rows = await queryWhere<SkillUsageRaw>`
    WITH events AS (
      SELECT
        CASE
          WHEN instr(trim(userPrompt), ' ') > 1
            THEN substr(trim(userPrompt), 2, instr(trim(userPrompt), ' ') - 2)
          ELSE substr(trim(userPrompt), 2)
        END AS name,
        agent, sessionId, project, timestamp
      FROM traces
      ${slashWhere}
      UNION ALL
      SELECT
        substr(toolName, 7) AS name,
        agent, sessionId, project, timestamp
      FROM traces
      ${toolWhere}
    )
    SELECT
      name,
      COUNT(*) AS count,
      COUNT(DISTINCT sessionId) AS sessions,
      COUNT(DISTINCT project)   AS projects,
      MIN(timestamp) AS firstSeen,
      MAX(timestamp) AS lastSeen,
      (SELECT group_concat(DISTINCT a) FROM (
         SELECT DISTINCT agent AS a FROM events e2 WHERE e2.name = events.name
       )) AS agentsCsv
    FROM events
    WHERE name IS NOT NULL AND name <> ''
    GROUP BY name
    ORDER BY count DESC, name ASC
    LIMIT 200
  `;

  // Real traces contain user prompts that start with `/` but aren't
  // slash commands — most commonly Unix paths (`/private/tmp/...`) or
  // multi-line pastes. A canonical skill name is a single word of
  // letters / digits / `-` / `_` / `:` (the colon being the plugin
  // separator, e.g. `git-flow:ship`). Reject anything else here
  // rather than baking the regex into SQL (which has no REGEXP by
  // default and gets unreadable fast with GLOB).
  const isCanonicalName = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;
  return rows
    .filter((r) => isCanonicalName.test(r.name))
    .map((r) => ({
      name: r.name,
      count: r.count,
      sessions: r.sessions,
      projects: r.projects,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      agents: r.agentsCsv ? r.agentsCsv.split(",").filter(Boolean).sort() : [],
    }));
}

export interface SkillSessionRow {
  sessionId: string;
  agent: string;
  project: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Drill-down for the /skills page: lists each (session, agent) that
 * fired the named skill, with per-session counts. Honors the same
 * project / agent / days filters as `getSkillUsage` so what you see
 * here matches the row you clicked.
 */
export async function getSkillSessions(name: string, f: Filters = {}): Promise<SkillSessionRow[]> {
  const baseFilters: Filters = {
    days: f.days,
    project: f.project,
    agent: f.agent,
  };
  const slashWhere = where(baseFilters, [
    `entryType = 'message'`,
    `role = 'user'`,
    `userPrompt IS NOT NULL`,
    `substr(trim(userPrompt), 1, 1) = '/'`,
    `length(trim(userPrompt)) > 1`,
  ]);
  const toolWhere = where(baseFilters, [
    `entryType = 'tool_call'`,
    `toolName LIKE 'skill:%'`,
    `length(toolName) > 6`,
  ]);
  return queryWhere<SkillSessionRow>`
    WITH events AS (
      SELECT
        CASE
          WHEN instr(trim(userPrompt), ' ') > 1
            THEN substr(trim(userPrompt), 2, instr(trim(userPrompt), ' ') - 2)
          ELSE substr(trim(userPrompt), 2)
        END AS name,
        agent, sessionId, project, timestamp
      FROM traces
      ${slashWhere}
      UNION ALL
      SELECT
        substr(toolName, 7) AS name,
        agent, sessionId, project, timestamp
      FROM traces
      ${toolWhere}
    )
    SELECT
      sessionId, agent, project,
      COUNT(*) AS count,
      MIN(timestamp) AS firstSeen,
      MAX(timestamp) AS lastSeen
    FROM events
    WHERE name = ${bind(name)} AND sessionId IS NOT NULL
    GROUP BY sessionId, agent, project
    ORDER BY lastSeen DESC
    LIMIT 200
  `;
}

/**
 * Skills are user prompts of the form `/word ...`. SQLite's REGEXP isn't
 * available without a custom function, so we use a LIKE pattern: the first
 * "word" looks like `/abcd` followed by space/end. A bit looser than the
 * DuckDB regex but produces the same result on real data.
 */
export async function getSkills(f: Filters = {}): Promise<SkillRow[]> {
  return queryWhere<SkillRow>`
    SELECT
      CASE
        WHEN instr(trim(userPrompt), ' ') > 0
          THEN substr(trim(userPrompt), 1, instr(trim(userPrompt), ' ') - 1)
        ELSE trim(userPrompt)
      END AS skill,
      COUNT(*) AS count
    FROM traces
    ${where(f, [
      `entryType = 'message'`,
      `role = 'user'`,
      `userPrompt IS NOT NULL`,
      `substr(trim(userPrompt), 1, 1) = '/'`,
      `length(trim(userPrompt)) > 1`,
    ])}
    GROUP BY skill
    ORDER BY count DESC
    LIMIT 20
  `;
}

// ── Lists (for selectors) ─────────────────────────────────────

export async function getProjectList(): Promise<string[]> {
  const rows = await query<{ project: string }>(`
    SELECT DISTINCT project
    FROM traces
    WHERE project IS NOT NULL
    ORDER BY project
  `);
  return rows.map((r) => r.project);
}

export async function getModelList(): Promise<string[]> {
  const rows = await query<{ model: string }>(`
    SELECT DISTINCT model
    FROM traces
    WHERE model IS NOT NULL
    ORDER BY model
  `);
  return rows.map((r) => r.model);
}

export async function getAgentList(): Promise<string[]> {
  const rows = await query<{ agent: string }>(`
    SELECT DISTINCT agent
    FROM traces
    WHERE agent IS NOT NULL
    ORDER BY agent
  `);
  return rows.map((r) => r.agent);
}

export async function getToolList(): Promise<string[]> {
  const rows = await query<{ toolName: string }>(`
    SELECT DISTINCT toolName
    FROM traces
    WHERE toolName IS NOT NULL
    ORDER BY toolName
  `);
  return rows.map((r) => r.toolName);
}

// ── Git Events ──────────────────────────────────────────────────

function gitWhere(f: Filters, extra?: (string | SQLFragment)[]): SQLFragment {
  const conds: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (extra) {
    for (const e of extra) {
      if (typeof e === "string") conds.push(e);
      else { conds.push(e.sql); params.push(...e.params); }
    }
  }
  conds.push(`timestamp IS NOT NULL`);
  if (f.days)    conds.push(`timestamp >= date('now', '-${Number(f.days)} days')`);
  if (f.project) { conds.push(`project = ?`); params.push(f.project); }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

export interface GitStats {
  total_commits: number;
  agent_commits: number;
  human_commits: number;
  /** Agent commits with a sessionId — linked back to a captured agent
   *  session. Drives the denominator for every session-level metric. */
  linked_agent_commits: number;
  /** Agent commits we can't tie to a session. The backfill heuristic
   *  matches by project + timestamp window; commits in projects with
   *  no concurrent session, or outside the window, end up here. */
  unlinked_agent_commits: number;
  total_insertions: number;
  total_deletions: number;
  agent_insertions: number;
  files_changed: number;
  repos: number;
}

export async function getGitStats(f: Filters = {}): Promise<GitStats> {
  const rows = await queryWhere<GitStats>`
    SELECT
      COUNT(*) AS total_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1) AS agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 0) AS human_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1 AND sessionId IS NOT NULL) AS linked_agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1 AND sessionId IS NULL)     AS unlinked_agent_commits,
      COALESCE(SUM(insertions), 0) AS total_insertions,
      COALESCE(SUM(deletions), 0) AS total_deletions,
      COALESCE(SUM(insertions) FILTER (WHERE agentAuthored = 1), 0) AS agent_insertions,
      COALESCE(SUM(filesChanged), 0) AS files_changed,
      COUNT(DISTINCT repo) AS repos
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'"])}
  `;
  return rows[0];
}

export interface CommitAttributionRow {
  project: string;
  agent_commits: number;
  linked_agent_commits: number;
  unlinked_agent_commits: number;
}

/**
 * Per-project commit-attribution breakdown. Powers the panel that
 * surfaces which projects' agent commits aren't linking to sessions —
 * the rows the dashboard's session-level metrics are silently
 * undercounting. Only projects with at least one agent commit appear;
 * human-only projects are omitted to keep the list short.
 *
 * Ordered worst-first: highest unlinked count, then highest total —
 * so the noisiest attribution gaps are at the top.
 */
export async function getCommitAttributionByProject(
  f: Filters = {},
): Promise<CommitAttributionRow[]> {
  return queryWhere<CommitAttributionRow>`
    SELECT
      project,
      COUNT(*) FILTER (WHERE agentAuthored = 1) AS agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1 AND sessionId IS NOT NULL) AS linked_agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1 AND sessionId IS NULL)     AS unlinked_agent_commits
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'", "project IS NOT NULL"])}
    GROUP BY project
    HAVING COUNT(*) FILTER (WHERE agentAuthored = 1) > 0
    ORDER BY unlinked_agent_commits DESC, agent_commits DESC, project ASC
  `;
}

export interface GitTimelineRow {
  date: string;
  agent_commits: number;
  human_commits: number;
  insertions: number;
  deletions: number;
}

export async function getGitTimeline(f: Filters = {}): Promise<GitTimelineRow[]> {
  return queryWhere<GitTimelineRow>`
    SELECT
      ${dateTrunc(f)} AS date,
      COUNT(*) FILTER (WHERE agentAuthored = 1) AS agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 0) AS human_commits,
      COALESCE(SUM(insertions), 0) AS insertions,
      COALESCE(SUM(deletions), 0) AS deletions
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'"])}
    GROUP BY date
    ORDER BY date
  `;
}

export interface GitCommitRow {
  commit_sha: string;
  timestamp: string;
  project: string;
  repo: string;
  branch: string;
  author: string;
  message: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  agent_authored: boolean;
  agent_name: string | null;
  session_id: string | null;
}

interface GitCommitRowRaw extends Omit<GitCommitRow, "agent_authored"> { agent_authored: number }

/**
 * Drill-down for the per-project commit attribution panel: list the
 * actual orphan agent commits in one project so the user can click
 * through to /commit?sha=… and inspect them. Same shape as
 * `getGitCommits` so the UI can reuse the formatting; the only
 * difference is the WHERE clause.
 */
export async function getUnlinkedAgentCommits(
  project: string,
  f: Filters = {},
  limit = 100,
): Promise<GitCommitRow[]> {
  const rows = await queryWhere<GitCommitRowRaw>`
    SELECT
      commitSha AS commit_sha,
      timestamp,
      project,
      repo,
      branch,
      COALESCE(author, '') AS author,
      COALESCE(message, '') AS message,
      COALESCE(filesChanged, 0) AS files_changed,
      COALESCE(insertions, 0) AS insertions,
      COALESCE(deletions, 0) AS deletions,
      COALESCE(agentAuthored, 0) AS agent_authored,
      agentName AS agent_name,
      sessionId AS session_id
    FROM git_events
    ${gitWhere(f, [
      "eventType = 'commit'",
      "agentAuthored = 1",
      "sessionId IS NULL",
      { sql: "project = ?", params: [project] },
    ])}
    ORDER BY timestamp DESC
    LIMIT ${Number(limit)}
  `;
  return rows.map((r) => ({ ...r, agent_authored: Boolean(r.agent_authored) }));
}

export async function getGitCommits(f: Filters = {}, limit = 50): Promise<GitCommitRow[]> {
  const rows = await queryWhere<GitCommitRowRaw>`
    SELECT
      commitSha AS commit_sha,
      timestamp,
      project,
      repo,
      branch,
      COALESCE(author, '') AS author,
      COALESCE(message, '') AS message,
      COALESCE(filesChanged, 0) AS files_changed,
      COALESCE(insertions, 0) AS insertions,
      COALESCE(deletions, 0) AS deletions,
      COALESCE(agentAuthored, 0) AS agent_authored,
      agentName AS agent_name,
      sessionId AS session_id
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'"])}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, agent_authored: Boolean(r.agent_authored) }));
}

// ── Commit detail (drill-down) ────────────────────────────────

export interface CommitDetail {
  commit_sha: string;
  timestamp: string;
  project: string;
  repo: string;
  branch: string;
  author: string;
  message: string;
  message_body: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  agent_authored: boolean;
  agent_name: string | null;
  session_id: string | null;
  files: string[];
}

interface CommitDetailRaw extends Omit<CommitDetail, "agent_authored" | "files"> {
  agent_authored: number;
  files: string | null;
}

export async function getCommitDetail(sha: string): Promise<CommitDetail | null> {
  const rows = await query<CommitDetailRaw>(`
    SELECT
      commitSha AS commit_sha,
      timestamp,
      project,
      repo,
      branch,
      COALESCE(author, '') AS author,
      COALESCE(message, '') AS message,
      messageBody AS message_body,
      COALESCE(filesChanged, 0) AS files_changed,
      COALESCE(insertions, 0) AS insertions,
      COALESCE(deletions, 0) AS deletions,
      COALESCE(agentAuthored, 0) AS agent_authored,
      agentName AS agent_name,
      sessionId AS session_id,
      files
    FROM git_events
    WHERE commitSha = ?
    LIMIT 1
  `, [sha]);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r,
    agent_authored: Boolean(r.agent_authored),
    files: r.files ? parseJsonArray(r.files) : [],
  };
}

/**
 * Sibling commits for a given session: every commit that shares this
 * sessionId, ordered chronologically. Used by the commit page to show
 * "this commit is one of N produced by the same session" — without it
 * the Agent Session card's whole-session totals (27h, 405M cache reads,
 * etc.) read like per-commit numbers, which they aren't.
 */
export async function getSessionCommits(sessionId: string): Promise<GitCommitRow[]> {
  const rows = await query<GitCommitRowRaw>(`
    SELECT
      commitSha          AS commit_sha,
      timestamp,
      project,
      repo,
      branch,
      author,
      message,
      COALESCE(filesChanged, 0) AS files_changed,
      COALESCE(insertions, 0)   AS insertions,
      COALESCE(deletions, 0)    AS deletions,
      COALESCE(agentAuthored, 0) AS agent_authored,
      agentName                 AS agent_name,
      sessionId                 AS session_id
    FROM git_events
    WHERE sessionId = ? AND eventType = 'commit'
    ORDER BY timestamp ASC
  `, [sessionId]);
  return rows.map((r) => ({ ...r, agent_authored: Boolean(r.agent_authored) }));
}

/**
 * Sessions that produced ≥1 commit in the filtered window, with the
 * session's total trace stats and the list of commits each one yielded.
 * Powers the "By session" view on the overview page.
 */
export interface GitSessionRow {
  session_id: string;
  agent: string;
  project: string;
  started: string;
  ended: string;
  duration_ms: number;
  entries: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  commits: GitCommitRow[];
}

export async function getGitSessions(f: Filters): Promise<GitSessionRow[]> {
  // Find session_ids that produced commits in-filter.
  const ids = await queryWhere<{ session_id: string }>`
    SELECT DISTINCT sessionId AS session_id
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'", "sessionId IS NOT NULL"])}
  `;
  if (ids.length === 0) return [];

  const idValues = ids.map((r) => r.session_id);
  const idPlaceholders = idValues.map(() => "?").join(",");
  const meta = await query<{
    session_id: string; agent: string; project: string;
    started: string; ended: string;
    entries: number;
    input_tokens: number; output_tokens: number; cache_read: number;
  }>(`
    SELECT
      sessionId AS session_id,
      agent,
      MAX(project) AS project,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
      COUNT(*) AS entries,
      COALESCE(SUM(${TU_INPUT}),  0) AS input_tokens,
      COALESCE(SUM(${TU_OUTPUT}), 0) AS output_tokens,
      COALESCE(SUM(${TU_CACHE_R}),0) AS cache_read
    FROM traces
    WHERE sessionId IN (${idPlaceholders})
    GROUP BY sessionId, agent
  `, idValues);

  const commitRows = await query<GitCommitRowRaw>(`
    SELECT
      sessionId AS session_id,
      commitSha AS commit_sha,
      timestamp,
      project,
      repo,
      branch,
      author,
      message,
      COALESCE(filesChanged, 0) AS files_changed,
      COALESCE(insertions, 0)   AS insertions,
      COALESCE(deletions, 0)    AS deletions,
      COALESCE(agentAuthored, 0) AS agent_authored,
      agentName                 AS agent_name
    FROM git_events
    WHERE sessionId IN (${idPlaceholders}) AND eventType = 'commit'
    ORDER BY timestamp ASC
  `, idValues);

  const commitsBySession = new Map<string, GitCommitRow[]>();
  for (const c of commitRows) {
    if (!c.session_id) continue;
    const list = commitsBySession.get(c.session_id) ?? [];
    list.push({ ...c, agent_authored: Boolean(c.agent_authored) });
    commitsBySession.set(c.session_id, list);
  }

  return meta
    .map((m) => {
      const start = new Date(m.started).getTime();
      const end = new Date(m.ended).getTime();
      return {
        ...m,
        duration_ms: isNaN(start) || isNaN(end) ? 0 : Math.max(0, end - start),
        commits: commitsBySession.get(m.session_id) ?? [],
      };
    })
    .sort((a, b) => (a.started < b.started ? 1 : -1));
}

// ── Session detail (trace entries for a session) ──────────────

export interface SessionEntry {
  timestamp: string;
  entry_type: string;
  tool_name: string | null;
  model: string | null;
  file_path: string | null;
  command: string | null;
  user_prompt: string | null;
  assistant_text: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface SessionDetail {
  session_id: string;
  agent: string;
  project: string;
  started: string;
  ended: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  /** Wall time minus consecutive-entry gaps that exceed IDLE_THRESHOLD_MS.
   *  Lets the UI show "3h active" alongside "27h wall" for long sessions
   *  where most of the wall time was idle. */
  active_ms: number;
  /** Per-bucket entry counts across [started..ended]. ~60 buckets, so the
   *  resolution adapts to session length: minute-ish for short sessions,
   *  hour-ish for multi-day ones. Powers the activity sparkline. */
  activity: { t: number; count: number }[];
  entries: SessionEntry[];
  tool_summary: { tool_name: string; count: number }[];
  commits: GitCommitRow[];
}

export interface SessionSummary {
  session_id: string;
  agent: string;
  project: string;
  started: string;
  ended: string;
  entries: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  tools: { tool_name: string; count: number }[];
  models: { model: string; count: number }[];
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  const [meta, tools, models] = await Promise.all([
    query<{
      session_id: string; agent: string; project: string;
      started: string; ended: string; entries: number;
      input_tokens: number; output_tokens: number; cache_read: number;
    }>(`
      SELECT
        sessionId AS session_id,
        MIN(agent) AS agent,
        MIN(project) AS project,
        MIN(timestamp) AS started,
        MAX(timestamp) AS ended,
        COUNT(*) AS entries,
        COALESCE(SUM(${TU_INPUT}), 0) AS input_tokens,
        COALESCE(SUM(${TU_OUTPUT}), 0) AS output_tokens,
        COALESCE(SUM(${TU_CACHE_R}), 0) AS cache_read
      FROM traces
      WHERE sessionId = ?
      GROUP BY sessionId
    `, [sessionId]),
    query<{ tool_name: string; count: number }>(`
      SELECT toolName AS tool_name, COUNT(*) AS count
      FROM traces
      WHERE sessionId = ? AND toolName IS NOT NULL
      GROUP BY toolName
      ORDER BY count DESC
    `, [sessionId]),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*) AS count
      FROM traces
      WHERE sessionId = ? AND model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
    `, [sessionId]),
  ]);
  if (meta.length === 0) return null;
  return { ...meta[0], tools, models };
}

interface SessionEntryRaw extends Omit<SessionEntry, "input_tokens" | "output_tokens"> {
  input_tokens: number | null;
  output_tokens: number | null;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const meta = await query<{
    session_id: string; agent: string; project: string;
    started: string; ended: string;
    input_tokens: number; output_tokens: number;
    cache_read: number; cache_creation: number;
  }>(`
    SELECT
      sessionId AS session_id,
      MIN(agent) AS agent,
      MIN(project) AS project,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended,
      COALESCE(SUM(${TU_INPUT}),   0) AS input_tokens,
      COALESCE(SUM(${TU_OUTPUT}),  0) AS output_tokens,
      COALESCE(SUM(${TU_CACHE_R}), 0) AS cache_read,
      COALESCE(SUM(${TU_CACHE_C}), 0) AS cache_creation
    FROM traces
    WHERE sessionId = ?
    GROUP BY sessionId
  `, [sessionId]);
  if (meta.length === 0) return null;

  const [entries, toolSummary, commits] = await Promise.all([
    // Trace entries (capped at 500). LEFT(...,500) → substr(...,1,500).
    query<SessionEntryRaw>(`
      SELECT
        timestamp,
        COALESCE(entryType, '') AS entry_type,
        toolName AS tool_name,
        model,
        filePath AS file_path,
        command,
        substr(userPrompt, 1, 500) AS user_prompt,
        substr(assistantText, 1, 500) AS assistant_text,
        ${TU_INPUT}  AS input_tokens,
        ${TU_OUTPUT} AS output_tokens
      FROM traces
      WHERE sessionId = ?
      ORDER BY timestamp
      LIMIT 500
    `, [sessionId]),
    query<{ tool_name: string; count: number }>(`
      SELECT
        toolName AS tool_name,
        COUNT(*) AS count
      FROM traces
      WHERE sessionId = ? AND toolName IS NOT NULL
      GROUP BY toolName
      ORDER BY count DESC
    `, [sessionId]),
    query<GitCommitRowRaw>(`
      SELECT
        commitSha AS commit_sha,
        timestamp,
        project,
        repo,
        branch,
        COALESCE(author, '') AS author,
        COALESCE(message, '') AS message,
        COALESCE(filesChanged, 0) AS files_changed,
        COALESCE(insertions, 0) AS insertions,
        COALESCE(deletions, 0) AS deletions,
        COALESCE(agentAuthored, 0) AS agent_authored,
        agentName AS agent_name,
        sessionId AS session_id
      FROM git_events
      WHERE sessionId = ? AND eventType = 'commit'
      ORDER BY timestamp
    `, [sessionId]),
  ]);

  // Pull every entry's timestamp once for active-time + sparkline. Cheap
  // even for 10K-entry sessions (one column scan + a sort).
  const allTimestamps = await query<{ timestamp: string }>(`
    SELECT timestamp FROM traces
    WHERE sessionId = ?
    ORDER BY timestamp
  `, [sessionId]);
  const { active_ms, activity } = computeActivityProfile(
    allTimestamps.map((r) => r.timestamp),
    meta[0].started,
    meta[0].ended,
  );

  return {
    ...meta[0],
    active_ms,
    activity,
    entries,
    tool_summary: toolSummary,
    commits: commits.map((r) => ({ ...r, agent_authored: Boolean(r.agent_authored) })),
  };
}

/**
 * From a sorted list of entry timestamps, compute:
 *   - active_ms: wall time minus gaps over IDLE_THRESHOLD_MS. So a 27-hour
 *     session with two 8-hour gaps (overnight) reports ~11h active.
 *   - activity: ~60 wall-time buckets with entry counts, for a sparkline.
 *
 * Idle threshold is fixed at 5 minutes — long enough that "thinking" or a
 * slow Bash command stays in the active span, short enough that meal/sleep
 * gaps fall out.
 */
function computeActivityProfile(
  timestamps: string[],
  started: string,
  ended: string,
): { active_ms: number; activity: { t: number; count: number }[] } {
  const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  const startMs = new Date(started).getTime();
  const endMs   = new Date(ended).getTime();
  if (timestamps.length === 0 || isNaN(startMs) || isNaN(endMs)) {
    return { active_ms: 0, activity: [] };
  }
  // Single-instant session (one entry, or all entries at the same
  // timestamp): return one bucket with the full count so the sparkline
  // still has something to render. Active time is 0 by definition.
  if (endMs <= startMs) {
    return { active_ms: 0, activity: [{ t: startMs, count: timestamps.length }] };
  }

  // Active time: walk consecutive timestamps, sum gaps ≤ threshold.
  let activeMs = 0;
  let prev = NaN;
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    if (isNaN(t)) continue;
    if (!isNaN(prev)) {
      const gap = t - prev;
      if (gap > 0 && gap <= IDLE_THRESHOLD_MS) activeMs += gap;
    }
    prev = t;
  }

  // ~60 wall-time buckets across [start..end].
  const N = 60;
  const bucketMs = Math.max(1, Math.floor((endMs - startMs) / N));
  const counts = new Array<number>(N).fill(0);
  for (const ts of timestamps) {
    const t = new Date(ts).getTime();
    if (isNaN(t)) continue;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((t - startMs) / bucketMs)));
    counts[idx]++;
  }
  const activity = counts.map((count, i) => ({ t: startMs + i * bucketMs, count }));

  return { active_ms: activeMs, activity };
}

// ── Helpers ────────────────────────────────────────────────────

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
