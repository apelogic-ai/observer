import { query } from "./db";

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

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Build a WHERE clause from common filters. Extra conditions can be prepended. */
function where(f: Filters, extra?: string[]): string {
  const conds: string[] = extra ? [...extra] : [];
  conds.push(`timestamp IS NOT NULL`);
  if (f.days)    conds.push(`timestamp >= date('now', '-${f.days} days')`);
  if (f.project) conds.push(`project = '${esc(f.project)}'`);
  if (f.model)   conds.push(`model = '${esc(f.model)}'`);
  if (f.tool) {
    // Sentinel "*mcp" filters across all MCP tools regardless of naming
    // convention (Claude Code emits `mcp:server:tool`, the API uses
    // `mcp__server__tool`). Anything else is treated as an exact match.
    if (f.tool === "*mcp") {
      conds.push(`(toolName LIKE 'mcp:%' OR toolName LIKE 'mcp\\_\\_%' ESCAPE '\\')`);
    } else {
      conds.push(`toolName = '${esc(f.tool)}'`);
    }
  }
  if (f.agent)   conds.push(`agent = '${esc(f.agent)}'`);
  return `WHERE ${conds.join(" AND ")}`;
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
  const rows = await query<Stats>(`
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
  `);
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
  return query<ActivityRow>(`
    SELECT
      ${dateTrunc(f)} AS date,
      agent,
      COUNT(*) AS count,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f)}
    GROUP BY date, agent
    ORDER BY date
  `);
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
  return query<HeatmapRow>(`
    SELECT
      ${dateTrunc(f)} AS date,
      project,
      agent,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f, ["project IS NOT NULL"])}
    GROUP BY date, project, agent
    ORDER BY date
  `);
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
  return query<TokenRow>(`
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
  `);
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
function securityWhere(f: Filters, extra?: string[]): string {
  const conds: string[] = extra ? [...extra] : [];
  conds.push(`timestamp IS NOT NULL`);
  // `date` (single calendar day) takes precedence over `days` (a window).
  // Used by the leaks page's chart click-to-drill — nonsense to combine.
  if (f.date) conds.push(`date(timestamp) = '${esc(f.date)}'`);
  else if (f.days) conds.push(`timestamp >= date('now', '-${f.days} days')`);
  if (f.project) conds.push(`project = '${esc(f.project)}'`);
  if (f.agent)   conds.push(`agent = '${esc(f.agent)}'`);
  return `WHERE ${conds.join(" AND ")}`;
}

export async function getSecurityFindings(
  f: Filters = {},
  limit = 25,
): Promise<SecurityFindingRow[]> {
  const rows = await query<SecurityFindingRawRow>(`
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
  `);
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
  return query<SecurityTimelineRow>(`
    SELECT
      ${dateTrunc(f)} AS date,
      patternType     AS patternType,
      COUNT(*)        AS count
    FROM security_findings
    ${securityWhere(f)}
    GROUP BY date, patternType
    ORDER BY date, patternType
  `);
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
  const rows = await query<SecuritySessionRawRow>(`
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
  `);
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
  const rows = await query<PermRawRow>(`
    SELECT toolName, command, sessionId
    FROM traces
    ${where(f, ["entryType = 'tool_call'", "toolName IS NOT NULL"])}
  `);

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
  const rows = await query<ToolRowRaw>(`
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
  `);
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
  const rows = await query<MotifRawRow>(`
    SELECT
      toolName,
      command,
      filePath,
      sessionId,
      ${TU_TOTAL} AS tokens
    FROM traces
    ${where(f, ["entryType = 'tool_call'", "toolName IS NOT NULL"])}
  `);

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
  const rows = await query<StumbleRawRow>(`
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
  `);

  // Session-wide totals come from message rows (where codex attributes its
  // tokens), not just the tool_call rows. We pull this in a second query so
  // the per-incident bucketing stays simple. Sessions outside the filter
  // window are skipped — the JOIN-equivalent here is the lookup map.
  const sessionTokenRows = await query<{ sessionId: string; total: number }>(`
    SELECT sessionId, SUM(${TU_TOTAL}) AS total
    FROM traces
    ${where(f, ["sessionId IS NOT NULL"])}
    GROUP BY sessionId
  `);
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
  const sessionRows = await query<{
    sessionId: string; agent: string; project: string | null;
    started: string; ended: string; tokens: number;
  }>(`
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
  `);

  const gitRows = await query<{ sessionId: string; commits: number; loc: number }>(`
    SELECT
      sessionId,
      COUNT(*) AS commits,
      COALESCE(SUM(COALESCE(insertions, 0) + COALESCE(deletions, 0)), 0) AS loc
    FROM git_events
    WHERE eventType = 'commit' AND sessionId IS NOT NULL
    GROUP BY sessionId
  `);
  const gitBySession = new Map<string, { commits: number; loc: number }>();
  for (const r of gitRows) gitBySession.set(r.sessionId, { commits: Number(r.commits), loc: Number(r.loc) });

  // Per-session timestamps for active-time computation (wall minus gaps
  // > 5 min). Sessions reused across days otherwise look multi-day.
  const tsRows = await query<{ sessionId: string; timestamp: string }>(`
    SELECT sessionId, timestamp
    FROM traces
    ${where(f, ["sessionId IS NOT NULL"])}
    ORDER BY sessionId, timestamp
  `);
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

// ── Projects ───────────────────────────────────────────────────

export interface ProjectRow {
  project: string;
  entries: number;
  sessions: number;
  output_tokens: number;
  total_tokens: number;
}

export async function getProjects(f: Filters = {}): Promise<ProjectRow[]> {
  return query<ProjectRow>(`
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
  `);
}

// ── Models ─────────────────────────────────────────────────────

export interface ModelRow {
  model: string;
  count: number;
  total_tokens: number;
}

export async function getModels(f: Filters = {}): Promise<ModelRow[]> {
  return query<ModelRow>(`
    SELECT
      model,
      COUNT(*) AS count,
      COALESCE(SUM(${TU_TOTAL}), 0) AS total_tokens
    FROM traces
    ${where(f, ["model IS NOT NULL"])}
    GROUP BY model
    ORDER BY total_tokens DESC
  `);
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
  const sessionFilter: string[] = ["sessionId IS NOT NULL"];
  if (f.tool) {
    sessionFilter.push(`sessionId IN (SELECT DISTINCT sessionId FROM traces WHERE toolName = '${esc(f.tool)}')`);
  }
  if (f.model) {
    sessionFilter.push(`sessionId IN (SELECT DISTINCT sessionId FROM traces WHERE model = '${esc(f.model)}')`);
  }
  const sessFilter: Filters = { days: f.days, project: f.project, granularity: f.granularity };

  return query<SessionRow>(`
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
  `);
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
  const toolCond = `toolName = '${esc(tool)}'`;
  const w = where(f, [toolCond]);

  const [totalRows, commands, files, timeline, byAgent, projects, models] = await Promise.all([
    query<{ total: number }>(`SELECT COUNT(*) AS total FROM traces ${w}`),
    query<ToolDetailRow>(`
      SELECT command AS value, COUNT(*) AS count
      FROM traces ${w} AND command IS NOT NULL
      GROUP BY command ORDER BY count DESC LIMIT 15
    `),
    query<ToolDetailRow>(`
      SELECT filePath AS value, COUNT(*) AS count
      FROM traces ${w} AND filePath IS NOT NULL
      GROUP BY filePath ORDER BY count DESC LIMIT 15
    `),
    query<{ date: string; count: number }>(`
      SELECT ${dateTrunc(f)} AS date, COUNT(*) AS count
      FROM traces ${w}
      GROUP BY date ORDER BY date
    `),
    query<{ agent: string; count: number }>(`
      SELECT agent, COUNT(*) AS count
      FROM traces ${w}
      GROUP BY agent ORDER BY count DESC
    `),
    query<{ project: string; count: number }>(`
      SELECT project, COUNT(*) AS count
      FROM traces ${w} AND project IS NOT NULL
      GROUP BY project ORDER BY count DESC
    `),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*) AS count
      FROM traces ${w} AND model IS NOT NULL
      GROUP BY model ORDER BY count DESC
    `),
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

/**
 * Skills are user prompts of the form `/word ...`. SQLite's REGEXP isn't
 * available without a custom function, so we use a LIKE pattern: the first
 * "word" looks like `/abcd` followed by space/end. A bit looser than the
 * DuckDB regex but produces the same result on real data.
 */
export async function getSkills(f: Filters = {}): Promise<SkillRow[]> {
  return query<SkillRow>(`
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
  `);
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

function gitWhere(f: Filters, extra?: string[]): string {
  const conds: string[] = extra ? [...extra] : [];
  conds.push(`timestamp IS NOT NULL`);
  if (f.days)    conds.push(`timestamp >= date('now', '-${f.days} days')`);
  if (f.project) conds.push(`project = '${esc(f.project)}'`);
  return `WHERE ${conds.join(" AND ")}`;
}

export interface GitStats {
  total_commits: number;
  agent_commits: number;
  human_commits: number;
  total_insertions: number;
  total_deletions: number;
  agent_insertions: number;
  files_changed: number;
  repos: number;
}

export async function getGitStats(f: Filters = {}): Promise<GitStats> {
  const rows = await query<GitStats>(`
    SELECT
      COUNT(*) AS total_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 1) AS agent_commits,
      COUNT(*) FILTER (WHERE agentAuthored = 0) AS human_commits,
      COALESCE(SUM(insertions), 0) AS total_insertions,
      COALESCE(SUM(deletions), 0) AS total_deletions,
      COALESCE(SUM(insertions) FILTER (WHERE agentAuthored = 1), 0) AS agent_insertions,
      COALESCE(SUM(filesChanged), 0) AS files_changed,
      COUNT(DISTINCT repo) AS repos
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'"])}
  `);
  return rows[0];
}

export interface GitTimelineRow {
  date: string;
  agent_commits: number;
  human_commits: number;
  insertions: number;
  deletions: number;
}

export async function getGitTimeline(f: Filters = {}): Promise<GitTimelineRow[]> {
  return query<GitTimelineRow>(`
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
  `);
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

export async function getGitCommits(f: Filters = {}, limit = 50): Promise<GitCommitRow[]> {
  const rows = await query<GitCommitRowRaw>(`
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
  `);
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
    WHERE commitSha = '${esc(sha)}'
    LIMIT 1
  `);
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
    WHERE sessionId = '${esc(sessionId)}' AND eventType = 'commit'
    ORDER BY timestamp ASC
  `);
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
  const ids = await query<{ session_id: string }>(`
    SELECT DISTINCT sessionId AS session_id
    FROM git_events
    ${gitWhere(f, ["eventType = 'commit'", "sessionId IS NOT NULL"])}
  `);
  if (ids.length === 0) return [];

  const idList = ids.map((r) => `'${esc(r.session_id)}'`).join(",");
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
    WHERE sessionId IN (${idList})
    GROUP BY sessionId, agent
  `);

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
    WHERE sessionId IN (${idList}) AND eventType = 'commit'
    ORDER BY timestamp ASC
  `);

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
      WHERE sessionId = '${esc(sessionId)}'
      GROUP BY sessionId
    `),
    query<{ tool_name: string; count: number }>(`
      SELECT toolName AS tool_name, COUNT(*) AS count
      FROM traces
      WHERE sessionId = '${esc(sessionId)}' AND toolName IS NOT NULL
      GROUP BY toolName
      ORDER BY count DESC
    `),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*) AS count
      FROM traces
      WHERE sessionId = '${esc(sessionId)}' AND model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
    `),
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
    WHERE sessionId = '${esc(sessionId)}'
    GROUP BY sessionId
  `);
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
      WHERE sessionId = '${esc(sessionId)}'
      ORDER BY timestamp
      LIMIT 500
    `),
    query<{ tool_name: string; count: number }>(`
      SELECT
        toolName AS tool_name,
        COUNT(*) AS count
      FROM traces
      WHERE sessionId = '${esc(sessionId)}' AND toolName IS NOT NULL
      GROUP BY toolName
      ORDER BY count DESC
    `),
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
      WHERE sessionId = '${esc(sessionId)}' AND eventType = 'commit'
      ORDER BY timestamp
    `),
  ]);

  // Pull every entry's timestamp once for active-time + sparkline. Cheap
  // even for 10K-entry sessions (one column scan + a sort).
  const allTimestamps = await query<{ timestamp: string }>(`
    SELECT timestamp FROM traces
    WHERE sessionId = '${esc(sessionId)}'
    ORDER BY timestamp
  `);
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
