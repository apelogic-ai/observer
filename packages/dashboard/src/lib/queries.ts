/** API response types — mirror the shapes returned by server/queries.ts */

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

export interface ActivityRow {
  date: string;
  agent: string;
  count: number;
  total_tokens: number;
}

export interface HeatmapRow {
  date: string;
  project: string;
  agent: string;
  total_tokens: number;
}

export interface TokenRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
}

export interface ToolRow {
  tool_name: string;
  count: number;
  primary_agent: string;
  agents: string[];
}

export interface MotifRow {
  toolName: string;
  shape: string;
  occurrences: number;
  sessions: number;
  tokens: number;
}

export interface StumbleRow {
  sessionId: string;
  agent: string;
  project: string | null;
  toolName: string;
  shape: string;
  occurrences: number;
  tokens: number;
  sessionTokens: number;
  firstAt: string;
  lastAt: string;
}

export type PermissionCategory = "core" | "build" | "file" | "mcp" | "other";

export interface PermissionRow {
  category: PermissionCategory;
  tool: string;
  path: string[];
  count: number;
  sessions: number;
  allowlistEntry: string;
}

export type ExistingSourceLabel = "user-global" | "project-shared" | "project-local";

export interface ExistingSource {
  label: ExistingSourceLabel;
  path: string;
  count: number;
  /** Set when the file existed but couldn't be read or parsed. */
  error?: string;
}

export interface ExistingSettings {
  allow: string[];
  sources: ExistingSource[];
  repoLocal: string | null;
}

export interface SecurityFindingRow {
  patternType: string;
  count: number;
  sessions: number;
  projects: number;
  agents: string[];
  firstAt: string;
  lastAt: string;
}

export interface SecurityTimelineRow {
  date: string;
  patternType: string;
  count: number;
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

export interface DarkSpendRow {
  sessionId: string;
  agent: string;
  project: string | null;
  started: string;
  ended: string;
  activeMs: number;
  tokens: number;
  commits: number;
  locDelta: number;
  tokensPerLoc: number;
}

export interface ProjectRow {
  project: string;
  entries: number;
  sessions: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ModelRow {
  model: string;
  count: number;
  total_tokens: number;
}

export interface SessionRow {
  session_id: string;
  agent: string;
  project: string;
  started: string;
  ended: string;
  entries: number;
  output_tokens: number;
}

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

export interface SkillRow {
  skill: string;
  count: number;
}

export interface SkillUsageRow {
  name: string;
  count: number;
  sessions: number;
  projects: number;
  firstSeen: string;
  lastSeen: string;
  agents: string[];
}

export interface SkillSessionRow {
  sessionId: string;
  agent: string;
  project: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

// ── Git Events ──────────────────────────────────────────────────

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

export interface GitTimelineRow {
  date: string;
  agent_commits: number;
  human_commits: number;
  insertions: number;
  deletions: number;
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

export interface CommitDetail extends GitCommitRow {
  message_body: string | null;
  session_id: string | null;
  files: string[];
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
  active_ms: number;
  activity: { t: number; count: number }[];
  entries: SessionEntry[];
  tool_summary: { tool_name: string; count: number }[];
  commits: GitCommitRow[];
}
