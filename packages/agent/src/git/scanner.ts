/**
 * Git event scanner — top-level orchestrator.
 *
 * 1. Reads normalized trace output to find active repos
 * 2. Resolves each project → local repo path
 * 3. Collects git commits for date ranges not yet processed
 * 4. Writes results to {outputDir}/{date}/git/
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoFromPath } from "../repo-resolver";
import { collectCommits } from "./collector";
import { GitCursors } from "./cursors";
import { writeGitEvents } from "./writer";
import type { GitEvent } from "./types";
import type { DisclosureLevel } from "../types";

export interface GitScanOptions {
  /** Normalized traces dir (e.g. ~/.observer/traces/normalized) */
  outputDir: string;
  /** State dir for cursors (e.g. ~/.observer) */
  stateDir: string;
  /** Disclosure level for filtering git event fields */
  disclosure: DisclosureLevel;
  /** Developer identity */
  developer: string;
  /** Machine identifier */
  machine: string;
  /** Extra repos from config: project → paths */
  extraRepos?: Record<string, string[]>;
}

/** @internal — exported for tests. */
export interface RepoMeta {
  project: string;
  localPath: string;
  repo: string;       // owner/repo
}

/**
 * Discover repos that had trace activity by scanning the normalized output dir.
 * Returns unique repos with their project name and local path.
 *
 * @internal — exported for tests.
 */
export function discoverActiveRepos(outputDir: string, extraRepos?: Record<string, string[]>): RepoMeta[] {
  if (!existsSync(outputDir)) return [];

  // Collect unique project names from trace files
  const projectNames = new Set<string>();
  const dateDirs = readdirSync(outputDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

  for (const dateDir of dateDirs) {
    const datePath = join(outputDir, dateDir);
    const agentDirs = readdirSync(datePath).filter((d) => d !== "git");

    for (const agentDir of agentDirs) {
      const agentPath = join(datePath, agentDir);
      let files: string[];
      try { files = readdirSync(agentPath).filter((f) => f.endsWith(".jsonl")); }
      catch { continue; }

      for (const file of files) {
        try {
          const content = readFileSync(join(agentPath, file), "utf-8");
          const firstLine = content.split("\n")[0];
          if (!firstLine) continue;
          const entry = JSON.parse(firstLine) as Record<string, unknown>;
          const project = entry.project as string;
          if (project) projectNames.add(project);
        } catch { continue; }
      }
    }
  }

  // For each project, find the matching repo via name-based resolution
  const seen = new Set<string>(); // repo key (org/name) to deduplicate
  const repos: RepoMeta[] = [];

  for (const project of projectNames) {
    const candidates = resolveProjectToPath(project);
    for (const candidate of candidates) {
      const repoInfo = resolveRepoFromPath(candidate);
      if (repoInfo && repoInfo.orgName && repoInfo.repoName) {
        const repoKey = `${repoInfo.orgName}/${repoInfo.repoName}`;
        if (!seen.has(repoKey)) {
          seen.add(repoKey);
          repos.push({ project, localPath: candidate, repo: repoKey });
        }
      }
    }
  }

  // Add explicitly configured extra repos
  if (extraRepos) {
    for (const [project, paths] of Object.entries(extraRepos)) {
      for (const p of paths) {
        const repoInfo = resolveRepoFromPath(p);
        if (repoInfo && repoInfo.orgName && repoInfo.repoName) {
          const repoKey = `${repoInfo.orgName}/${repoInfo.repoName}`;
          if (!seen.has(repoKey)) {
            seen.add(repoKey);
            repos.push({ project, localPath: p, repo: repoKey });
          }
        }
      }
    }
  }

  return repos;
}

/**
 * Attempt to resolve a project name to local filesystem paths.
 * Tries common dev directory patterns with the project name.
 */
function resolveProjectToPath(project: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates: string[] = [];

  for (const prefix of ["dev", "src", "projects", "work", "code", ""]) {
    const base = prefix ? join(home, prefix, project) : join(home, project);
    candidates.push(base);
  }

  return candidates;
}


/**
 * Get all date directories in the normalized output that have trace data.
 */
function getTraceDates(outputDir: string): string[] {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

// ---------------------------------------------------------------------------
// Session-based agent attribution
// ---------------------------------------------------------------------------

/** @internal — exported for tests. */
export interface SessionWindow {
  agent: string;
  sessionId: string;
  start: number;  // epoch ms
  end: number;    // epoch ms
}

/**
 * Read trace files for a project on a given date and extract session windows.
 * A session window is [min(timestamp), max(timestamp)] for each sessionId.
 */
/** @internal — exported for tests. */
export function getSessionWindows(outputDir: string, date: string, project: string): SessionWindow[] {
  const datePath = join(outputDir, date);
  if (!existsSync(datePath)) return [];

  const windows = new Map<string, SessionWindow>();
  const agentDirs = readdirSync(datePath).filter((d) => d !== "git");

  for (const agentDir of agentDirs) {
    const agentPath = join(datePath, agentDir);
    let files: string[];
    try {
      files = readdirSync(agentPath).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      try {
        const content = readFileSync(join(agentPath, file), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (entry.project !== project) continue;

          const sid = entry.sessionId as string | undefined;
          const ts = entry.timestamp as string | undefined;
          if (!sid || !ts) continue;

          const epoch = new Date(ts).getTime();
          if (isNaN(epoch)) continue;

          const existing = windows.get(sid);
          if (existing) {
            existing.start = Math.min(existing.start, epoch);
            existing.end = Math.max(existing.end, epoch);
          } else {
            windows.set(sid, {
              agent: agentDir,
              sessionId: sid,
              start: epoch,
              end: epoch,
            });
          }
        }
      } catch { continue; }
    }
  }

  // Add a 5-minute buffer on each side to account for commit timing vs trace timing
  const BUFFER_MS = 5 * 60 * 1000;
  return [...windows.values()].map((w) => ({
    ...w,
    start: w.start - BUFFER_MS,
    end: w.end + BUFFER_MS,
  }));
}

/**
 * Enrich git events with session-based agent attribution.
 * If a commit isn't already agent-attributed (via Co-Authored-By),
 * check if it falls within any agent session window for the same project.
 */
/** @internal — exported for tests. */
export function attributeFromSessions(events: GitEvent[], sessions: SessionWindow[]): void {
  if (sessions.length === 0) return;

  for (const event of events) {
    if (event.agentAuthored) continue;  // already attributed via Co-Authored-By

    const commitTime = new Date(event.timestamp).getTime();
    if (isNaN(commitTime)) continue;

    for (const session of sessions) {
      if (commitTime >= session.start && commitTime <= session.end) {
        event.agentAuthored = true;
        event.agentName = session.agent;
        event.sessionId = session.sessionId;
        break;
      }
    }
  }
}

/**
 * Add one day to a YYYY-MM-DD string.
 */
function nextDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Run git event collection for all repos that had trace activity.
 * Respects per-repo cursors to avoid re-collecting.
 *
 * Returns total number of git events collected.
 */
export function scanGitEvents(opts: GitScanOptions): number {
  const repos = discoverActiveRepos(opts.outputDir, opts.extraRepos);
  if (repos.length === 0) return 0;

  const cursors = new GitCursors(opts.stateDir);
  const traceDates = getTraceDates(opts.outputDir);
  if (traceDates.length === 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  let totalEvents = 0;

  for (const { project, localPath, repo } of repos) {
    const lastCollected = cursors.get(repo);
    const startDate = lastCollected ? nextDay(lastCollected) : traceDates[0];

    // Don't collect future dates
    if (startDate > today) continue;

    // Collect day by day from startDate through today
    let currentDate = startDate;
    while (currentDate <= today) {
      const events = collectCommits({
        repoPath: localPath,
        since: currentDate,
        until: nextDay(currentDate),
        project,
        repo,
        developer: opts.developer,
        machine: opts.machine,
      });

      if (events.length > 0) {
        // Enrich with session-based attribution (catches Codex, etc.)
        const sessions = getSessionWindows(opts.outputDir, currentDate, project);
        attributeFromSessions(events, sessions);

        const written = writeGitEvents(events, repo, {
          outputDir: opts.outputDir,
          disclosure: opts.disclosure,
        });
        totalEvents += written;
      }

      cursors.set(repo, currentDate);
      currentDate = nextDay(currentDate);
    }
  }

  cursors.save();
  return totalEvents;
}
