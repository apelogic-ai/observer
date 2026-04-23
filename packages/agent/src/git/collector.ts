/**
 * Git event collector — runs `git log` on local repos and parses output
 * into GitEvent objects.
 */

import { execSync } from "node:child_process";
import { gitEventId, type GitEvent } from "./types";

// Delimiters unlikely to appear in commit messages
const COMMIT_BEGIN = "---GIT_EVENT_BEGIN---";
const FIELD_SEP = "---GIT_EVENT_FIELD---";

// git log format: BEGIN marker, then SHA, parents, author name, email, date, subject, body
// With --numstat, git appends stat lines AFTER the format output for each commit.
// Using a BEGIN marker means each chunk = format_fields + numstat_lines.
const LOG_FORMAT = COMMIT_BEGIN + [
  "%H", "%P", "%an", "%ae", "%aI", "%s", "%b",
].join(FIELD_SEP);

// ---------------------------------------------------------------------------
// Agent attribution
// ---------------------------------------------------------------------------

const AGENT_COAUTHOR_PATTERNS: [RegExp, string][] = [
  [/claude/i, "claude_code"],
  [/anthropic/i, "claude_code"],
  [/codex/i, "codex"],
  [/openai/i, "codex"],
  [/cursor/i, "cursor"],
];

const AGENT_AUTHOR_PATTERNS: [RegExp, string][] = [
  [/noreply@anthropic\.com/i, "claude_code"],
  [/\bclaude\b/i, "claude_code"],
  [/noreply@openai\.com/i, "codex"],
  [/\bcodex\b/i, "codex"],
  [/noreply@cursor\.com/i, "cursor"],
];

function extractCoAuthors(body: string): string[] {
  const matches: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^Co-Authored-By:\s*(.+)/i);
    if (m) matches.push(m[1].trim());
  }
  return matches;
}

function detectAgent(
  coAuthors: string[],
  authorEmail: string,
): { agentAuthored: boolean; agentName: string | null } {
  // Check Co-Authored-By trailers first (strongest signal)
  for (const ca of coAuthors) {
    for (const [pattern, agent] of AGENT_COAUTHOR_PATTERNS) {
      if (pattern.test(ca)) {
        return { agentAuthored: true, agentName: agent };
      }
    }
  }

  // Check author email
  for (const [pattern, agent] of AGENT_AUTHOR_PATTERNS) {
    if (pattern.test(authorEmail)) {
      return { agentAuthored: true, agentName: agent };
    }
  }

  return { agentAuthored: false, agentName: null };
}

// ---------------------------------------------------------------------------
// Parse numstat output
// ---------------------------------------------------------------------------

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

function parseNumstat(lines: string[]): DiffStats {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // numstat format: "10\t5\tpath/to/file" (binary files show "-" for counts)
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const ins = parseInt(parts[0], 10);
    const del = parseInt(parts[1], 10);
    if (!isNaN(ins)) insertions += ins;
    if (!isNaN(del)) deletions += del;
    files.push(parts.slice(2).join("\t")); // handle paths with tabs
  }

  return { filesChanged: files.length, insertions, deletions, files };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CollectOptions {
  repoPath: string;
  since: string;           // ISO date (inclusive), e.g. "2026-04-22"
  until: string;           // ISO date (exclusive), e.g. "2026-04-23"
  project: string;
  repo: string;            // owner/repo
  developer: string;
  machine: string;
  branch?: string;         // if known; otherwise git log --all
}

/**
 * Collect git commits from a local repo for a date range.
 * Returns GitEvent[] sorted by timestamp.
 */
export function collectCommits(opts: CollectOptions): GitEvent[] {
  const { repoPath, since, until, project, repo, developer, machine } = opts;

  let raw: string;
  try {
    raw = execSync(
      `git log --all --format="${LOG_FORMAT}" --numstat --after="${since}T00:00:00" --before="${until}T00:00:00"`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
    );
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  return parseGitLog(raw, { project, repo, developer, machine, repoPath });
}

/**
 * Parse raw `git log` output into GitEvent[].
 * Exported for testing.
 */
export function parseGitLog(
  raw: string,
  meta: { project: string; repo: string; developer: string; machine: string; repoPath: string },
): GitEvent[] {
  const events: GitEvent[] = [];
  const chunks = raw.split(COMMIT_BEGIN);

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    // Split on first occurrence of FIELD_SEP for each field
    const parts = trimmed.split(FIELD_SEP);
    if (parts.length < 6) continue;

    const sha = parts[0].trim();
    const parentStr = parts[1].trim();
    const authorName = parts[2].trim();
    const authorEmail = parts[3].trim();
    const dateStr = parts[4].trim();
    const subject = parts[5].trim();

    // Body + numstat are in parts[6] (everything after the 6th separator)
    const bodyAndStats = parts.slice(6).join(FIELD_SEP);
    const bodyLines: string[] = [];
    const numstatLines: string[] = [];

    let inNumstat = false;
    for (const line of bodyAndStats.split("\n")) {
      // numstat lines start with digits or "-" (binary), then tab
      if (/^\d+\t/.test(line) || /^-\t-\t/.test(line)) {
        inNumstat = true;
      }
      if (inNumstat) {
        numstatLines.push(line);
      } else {
        bodyLines.push(line);
      }
    }

    const body = bodyLines.join("\n").trim();
    const coAuthors = extractCoAuthors(body);
    const { agentAuthored, agentName } = detectAgent(coAuthors, authorEmail);
    const stats = parseNumstat(numstatLines);
    const parentShas = parentStr ? parentStr.split(" ").filter(Boolean) : [];
    const branch = getBranchFromParents(sha) ?? "";

    events.push({
      id: gitEventId(meta.repo, "commit", sha),
      timestamp: dateStr,
      eventType: "commit",
      project: meta.project,
      repo: meta.repo,
      branch,
      developer: meta.developer,
      machine: meta.machine,

      commitSha: sha,
      parentShas: parentShas.length > 0 ? parentShas : null,
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,

      agentAuthored,
      agentName,

      author: authorName || null,
      authorEmail: authorEmail || null,
      coAuthors: coAuthors.length > 0 ? coAuthors : null,
      message: subject || null,
      files: stats.files.length > 0 ? stats.files : null,
      sessionId: null,

      prNumber: null,
      prTitle: null,
      prState: null,
      prUrl: null,
      prBaseBranch: null,
      prHeadBranch: null,

      messageBody: body || null,
      repoLocal: meta.repoPath,
    });
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Placeholder — branch detection from SHA requires `git branch --contains`.
 * For now returns null; the scanner will set the branch from trace metadata.
 */
function getBranchFromParents(_sha: string): string | null {
  return null;
}
