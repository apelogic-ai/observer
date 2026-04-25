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
  granularity?: "day" | "week" | "month";
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
  if (f.tool)    conds.push(`toolName = '${esc(f.tool)}'`);
  return `WHERE ${conds.join(" AND ")}`;
}

/** json_extract on tokenUsage — null-safe SUM helper. */
const TU_INPUT  = `json_extract(tokenUsage, '$.input')`;
const TU_OUTPUT = `json_extract(tokenUsage, '$.output')`;
const TU_CACHE_R = `json_extract(tokenUsage, '$.cacheRead')`;
const TU_CACHE_C = `json_extract(tokenUsage, '$.cacheCreation')`;

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
}

export async function getActivity(f: Filters = {}): Promise<ActivityRow[]> {
  return query<ActivityRow>(`
    SELECT
      ${dateTrunc(f)} AS date,
      agent,
      COUNT(*) AS count
    FROM traces
    ${where(f)}
    GROUP BY date, agent
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

// ── Projects ───────────────────────────────────────────────────

export interface ProjectRow {
  project: string;
  entries: number;
  sessions: number;
  output_tokens: number;
}

export async function getProjects(f: Filters = {}): Promise<ProjectRow[]> {
  return query<ProjectRow>(`
    SELECT
      project,
      COUNT(*) AS entries,
      COUNT(DISTINCT sessionId) AS sessions,
      COALESCE(SUM(${TU_OUTPUT}), 0) AS output_tokens
    FROM traces
    ${where(f, ["project IS NOT NULL"])}
    GROUP BY project
    ORDER BY entries DESC
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
      COALESCE(SUM(COALESCE(${TU_INPUT},0) + COALESCE(${TU_OUTPUT},0)), 0) AS total_tokens
    FROM traces
    ${where(f, ["model IS NOT NULL"])}
    GROUP BY model
    ORDER BY count DESC
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
      agentName AS agent_name
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
  }>(`
    SELECT
      sessionId AS session_id,
      MIN(agent) AS agent,
      MIN(project) AS project,
      MIN(timestamp) AS started,
      MAX(timestamp) AS ended
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
        agentName AS agent_name
      FROM git_events
      WHERE sessionId = '${esc(sessionId)}' AND eventType = 'commit'
      ORDER BY timestamp
    `),
  ]);

  return {
    ...meta[0],
    entries,
    tool_summary: toolSummary,
    commits: commits.map((r) => ({ ...r, agent_authored: Boolean(r.agent_authored) })),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
