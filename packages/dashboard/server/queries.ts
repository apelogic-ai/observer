import { query } from "./db";

/** Cast the VARCHAR timestamp to TIMESTAMP for date comparisons. */
const TS = `CAST(timestamp AS TIMESTAMP)`;

export interface Filters {
  days?: number;
  project?: string;
  model?: string;
  tool?: string;
  granularity?: "day" | "week" | "month";
}

/** SQL expression for date bucketing based on granularity. */
function dateTrunc(f: Filters): string {
  switch (f.granularity) {
    case "week":  return `CAST(DATE_TRUNC('week', ${TS}) AS DATE)::VARCHAR`;
    case "month": return `CAST(DATE_TRUNC('month', ${TS}) AS DATE)::VARCHAR`;
    default:      return `CAST(${TS} AS DATE)::VARCHAR`;
  }
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Build a WHERE clause from common filters. Extra conditions can be prepended. */
function where(f: Filters, extra?: string[]): string {
  const conds: string[] = extra ? [...extra] : [];
  conds.push(`timestamp IS NOT NULL`);
  if (f.days) conds.push(`${TS} >= CURRENT_DATE - INTERVAL '${f.days} days'`);
  if (f.project) conds.push(`project = '${esc(f.project)}'`);
  if (f.model) conds.push(`model = '${esc(f.model)}'`);
  if (f.tool) conds.push(`"toolName" = '${esc(f.tool)}'`);
  return `WHERE ${conds.join(" AND ")}`;
}

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
      COUNT(*)::INTEGER                                          AS total_entries,
      COUNT(DISTINCT "sessionId")::INTEGER                       AS total_sessions,
      COUNT(DISTINCT project)::INTEGER                           AS total_projects,
      COUNT(DISTINCT CAST(${TS} AS DATE))::INTEGER               AS total_days,
      COALESCE(SUM("tokenUsage"."input"), 0)::BIGINT             AS total_input_tokens,
      COALESCE(SUM("tokenUsage"."output"), 0)::BIGINT            AS total_output_tokens,
      COALESCE(SUM("tokenUsage"."cacheRead"), 0)::BIGINT         AS total_cache_read,
      COALESCE(SUM("tokenUsage"."cacheCreation"), 0)::BIGINT     AS total_cache_creation
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
      COUNT(*)::INTEGER AS count
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
      COALESCE(SUM("tokenUsage"."input"), 0)::BIGINT             AS input_tokens,
      COALESCE(SUM("tokenUsage"."output"), 0)::BIGINT            AS output_tokens,
      COALESCE(SUM("tokenUsage"."cacheRead"), 0)::BIGINT         AS cache_read,
      COALESCE(SUM("tokenUsage"."cacheCreation"), 0)::BIGINT     AS cache_creation
    FROM traces
    ${where(f, ['"tokenUsage" IS NOT NULL'])}
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

export async function getTools(f: Filters = {}, limit = 25): Promise<ToolRow[]> {
  return query<ToolRow>(`
    SELECT
      "toolName" AS tool_name,
      COUNT(*)::INTEGER AS count,
      MODE(agent) AS primary_agent,
      LIST(DISTINCT agent) AS agents
    FROM traces
    ${where(f, ['"toolName" IS NOT NULL'])}
    GROUP BY "toolName"
    ORDER BY count DESC
    LIMIT ${limit}
  `);
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
      COUNT(*)::INTEGER AS entries,
      COUNT(DISTINCT "sessionId")::INTEGER AS sessions,
      COALESCE(SUM("tokenUsage"."output"), 0)::BIGINT AS output_tokens
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
      COUNT(*)::INTEGER AS count,
      COALESCE(SUM("tokenUsage"."input" + "tokenUsage"."output"), 0)::BIGINT AS total_tokens
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
  // Tool/model filter: restrict to sessions that contain matching entries
  const sessionFilter: string[] = ['"sessionId" IS NOT NULL'];
  if (f.tool) {
    sessionFilter.push(`"sessionId" IN (SELECT DISTINCT "sessionId" FROM traces WHERE "toolName" = '${esc(f.tool)}')`);
  }
  if (f.model) {
    sessionFilter.push(`"sessionId" IN (SELECT DISTINCT "sessionId" FROM traces WHERE model = '${esc(f.model)}')`);
  }
  // Don't pass tool/model to where() — they'd incorrectly filter individual rows
  const sessFilter: Filters = { days: f.days, project: f.project, granularity: f.granularity };

  return query<SessionRow>(`
    SELECT
      "sessionId" AS session_id,
      FIRST(agent) AS agent,
      FIRST(project) AS project,
      MIN(timestamp)::VARCHAR AS started,
      MAX(timestamp)::VARCHAR AS ended,
      COUNT(*)::INTEGER AS entries,
      COALESCE(SUM("tokenUsage"."output"), 0)::BIGINT AS output_tokens
    FROM traces
    ${where(sessFilter, sessionFilter)}
    GROUP BY "sessionId"
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
  const toolCond = `"toolName" = '${esc(tool)}'`;
  const w = where(f, [toolCond]);

  const [totalRows, commands, files, timeline, byAgent, projects, models] = await Promise.all([
    query<{ total: number }>(`SELECT COUNT(*)::INTEGER AS total FROM traces ${w}`),
    query<ToolDetailRow>(`
      SELECT command AS value, COUNT(*)::INTEGER AS count
      FROM traces ${w} AND command IS NOT NULL
      GROUP BY command ORDER BY count DESC LIMIT 15
    `),
    query<ToolDetailRow>(`
      SELECT "filePath" AS value, COUNT(*)::INTEGER AS count
      FROM traces ${w} AND "filePath" IS NOT NULL
      GROUP BY "filePath" ORDER BY count DESC LIMIT 15
    `),
    query<{ date: string; count: number }>(`
      SELECT ${dateTrunc(f)} AS date, COUNT(*)::INTEGER AS count
      FROM traces ${w}
      GROUP BY date ORDER BY date
    `),
    query<{ agent: string; count: number }>(`
      SELECT agent, COUNT(*)::INTEGER AS count
      FROM traces ${w}
      GROUP BY agent ORDER BY count DESC
    `),
    query<{ project: string; count: number }>(`
      SELECT project, COUNT(*)::INTEGER AS count
      FROM traces ${w} AND project IS NOT NULL
      GROUP BY project ORDER BY count DESC
    `),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*)::INTEGER AS count
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

export async function getSkills(f: Filters = {}): Promise<SkillRow[]> {
  return query<SkillRow>(`
    SELECT
      SPLIT_PART(TRIM("userPrompt"), ' ', 1) AS skill,
      COUNT(*)::INTEGER AS count
    FROM traces
    ${where(f, [
      '"entryType" = \'message\'',
      'role = \'user\'',
      '"userPrompt" IS NOT NULL',
      `regexp_matches(TRIM("userPrompt"), '^/[a-z][a-z0-9_:-]{0,30}(\\s|$)')`,
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
  if (f.days) conds.push(`CAST(timestamp AS TIMESTAMP) >= CURRENT_DATE - INTERVAL '${f.days} days'`);
  if (f.project) conds.push(`project = '${esc(f.project)}'`);
  return `WHERE ${conds.join(" AND ")}`;
}

export interface GitStatsRow {
  total_commits: number;
  agent_commits: number;
  human_commits: number;
  total_insertions: number;
  total_deletions: number;
  agent_insertions: number;
  files_changed: number;
  repos: number;
}

export async function getGitStats(f: Filters = {}): Promise<GitStatsRow> {
  const rows = await query<GitStatsRow>(`
    SELECT
      COUNT(*)::INTEGER AS total_commits,
      COUNT(*) FILTER (WHERE "agentAuthored" = true)::INTEGER AS agent_commits,
      COUNT(*) FILTER (WHERE "agentAuthored" = false)::INTEGER AS human_commits,
      COALESCE(SUM(insertions), 0)::INTEGER AS total_insertions,
      COALESCE(SUM(deletions), 0)::INTEGER AS total_deletions,
      COALESCE(SUM(insertions) FILTER (WHERE "agentAuthored" = true), 0)::INTEGER AS agent_insertions,
      COALESCE(SUM("filesChanged"), 0)::INTEGER AS files_changed,
      COUNT(DISTINCT repo)::INTEGER AS repos
    FROM git_events
    ${gitWhere(f, ['"eventType" = \'commit\''])}
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
  const trunc = f.granularity === "week"
    ? `CAST(DATE_TRUNC('week', CAST(timestamp AS TIMESTAMP)) AS DATE)::VARCHAR`
    : f.granularity === "month"
    ? `CAST(DATE_TRUNC('month', CAST(timestamp AS TIMESTAMP)) AS DATE)::VARCHAR`
    : `CAST(CAST(timestamp AS TIMESTAMP) AS DATE)::VARCHAR`;

  return query<GitTimelineRow>(`
    SELECT
      ${trunc} AS date,
      COUNT(*) FILTER (WHERE "agentAuthored" = true)::INTEGER AS agent_commits,
      COUNT(*) FILTER (WHERE "agentAuthored" = false)::INTEGER AS human_commits,
      COALESCE(SUM(insertions), 0)::INTEGER AS insertions,
      COALESCE(SUM(deletions), 0)::INTEGER AS deletions
    FROM git_events
    ${gitWhere(f, ['"eventType" = \'commit\''])}
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

export async function getGitCommits(f: Filters = {}, limit = 50): Promise<GitCommitRow[]> {
  return query<GitCommitRow>(`
    SELECT
      "commitSha" AS commit_sha,
      timestamp::VARCHAR AS timestamp,
      project,
      repo,
      branch,
      COALESCE(author, '') AS author,
      COALESCE(message, '') AS message,
      COALESCE("filesChanged", 0)::INTEGER AS files_changed,
      COALESCE(insertions, 0)::INTEGER AS insertions,
      COALESCE(deletions, 0)::INTEGER AS deletions,
      "agentAuthored" AS agent_authored,
      "agentName" AS agent_name
    FROM git_events
    ${gitWhere(f, ['"eventType" = \'commit\''])}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `);
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

export async function getCommitDetail(sha: string): Promise<CommitDetail | null> {
  const rows = await query<CommitDetail>(`
    SELECT
      "commitSha" AS commit_sha,
      timestamp::VARCHAR AS timestamp,
      project,
      repo,
      branch,
      COALESCE(author, '') AS author,
      COALESCE(message, '') AS message,
      "messageBody" AS message_body,
      COALESCE("filesChanged", 0)::INTEGER AS files_changed,
      COALESCE(insertions, 0)::INTEGER AS insertions,
      COALESCE(deletions, 0)::INTEGER AS deletions,
      "agentAuthored" AS agent_authored,
      "agentName" AS agent_name,
      "sessionId" AS session_id,
      COALESCE(files, ARRAY[]::VARCHAR[]) AS files
    FROM git_events
    WHERE "commitSha" = '${esc(sha)}'
    LIMIT 1
  `);
  return rows[0] ?? null;
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
        "sessionId" AS session_id,
        FIRST(agent) AS agent,
        FIRST(project) AS project,
        MIN(timestamp)::VARCHAR AS started,
        MAX(timestamp)::VARCHAR AS ended,
        COUNT(*)::INTEGER AS entries,
        COALESCE(SUM("tokenUsage"."input"), 0)::BIGINT AS input_tokens,
        COALESCE(SUM("tokenUsage"."output"), 0)::BIGINT AS output_tokens,
        COALESCE(SUM("tokenUsage"."cacheRead"), 0)::BIGINT AS cache_read
      FROM traces
      WHERE "sessionId" = '${esc(sessionId)}'
      GROUP BY "sessionId"
    `),
    query<{ tool_name: string; count: number }>(`
      SELECT "toolName" AS tool_name, COUNT(*)::INTEGER AS count
      FROM traces
      WHERE "sessionId" = '${esc(sessionId)}' AND "toolName" IS NOT NULL
      GROUP BY "toolName"
      ORDER BY count DESC
    `),
    query<{ model: string; count: number }>(`
      SELECT model, COUNT(*)::INTEGER AS count
      FROM traces
      WHERE "sessionId" = '${esc(sessionId)}' AND model IS NOT NULL
      GROUP BY model
      ORDER BY count DESC
    `),
  ]);
  if (meta.length === 0) return null;
  return { ...meta[0], tools, models };
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  // Session metadata
  const meta = await query<{
    session_id: string; agent: string; project: string;
    started: string; ended: string;
  }>(`
    SELECT
      "sessionId" AS session_id,
      FIRST(agent) AS agent,
      FIRST(project) AS project,
      MIN(timestamp)::VARCHAR AS started,
      MAX(timestamp)::VARCHAR AS ended
    FROM traces
    WHERE "sessionId" = '${esc(sessionId)}'
    GROUP BY "sessionId"
  `);
  if (meta.length === 0) return null;

  const [entries, toolSummary, commits] = await Promise.all([
    // Trace entries (capped at 500)
    query<SessionEntry>(`
      SELECT
        timestamp::VARCHAR AS timestamp,
        COALESCE("entryType", '') AS entry_type,
        "toolName" AS tool_name,
        model,
        "filePath" AS file_path,
        command,
        LEFT("userPrompt", 500) AS user_prompt,
        LEFT("assistantText", 500) AS assistant_text,
        ("tokenUsage"."input")::INTEGER AS input_tokens,
        ("tokenUsage"."output")::INTEGER AS output_tokens
      FROM traces
      WHERE "sessionId" = '${esc(sessionId)}'
      ORDER BY timestamp
      LIMIT 500
    `),
    // Tool usage summary
    query<{ tool_name: string; count: number }>(`
      SELECT
        "toolName" AS tool_name,
        COUNT(*)::INTEGER AS count
      FROM traces
      WHERE "sessionId" = '${esc(sessionId)}' AND "toolName" IS NOT NULL
      GROUP BY "toolName"
      ORDER BY count DESC
    `),
    // Linked commits
    query<GitCommitRow>(`
      SELECT
        "commitSha" AS commit_sha,
        timestamp::VARCHAR AS timestamp,
        project,
        repo,
        branch,
        COALESCE(author, '') AS author,
        COALESCE(message, '') AS message,
        COALESCE("filesChanged", 0)::INTEGER AS files_changed,
        COALESCE(insertions, 0)::INTEGER AS insertions,
        COALESCE(deletions, 0)::INTEGER AS deletions,
        "agentAuthored" AS agent_authored,
        "agentName" AS agent_name
      FROM git_events
      WHERE "sessionId" = '${esc(sessionId)}' AND "eventType" = 'commit'
      ORDER BY timestamp
    `),
  ]);

  return {
    ...meta[0],
    entries,
    tool_summary: toolSummary,
    commits,
  };
}
