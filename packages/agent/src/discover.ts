/**
 * Discover agent trace sources on the local machine.
 * Scans known directories for Claude Code, Codex, and other agents.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { resolveRepoFromClaudeProject, resolveCursorWorkspacePath } from "./repo-resolver";

export type AgentType = "claude_code" | "codex" | "cursor";

export interface TraceSource {
  agent: AgentType;
  project: string;
  files: string[];
}

export interface DiscoverOptions {
  claudeCodeDir?: string;
  codexDir?: string;
  cursorDir?: string;
}

/**
 * Discover all trace file sources from configured agent directories.
 */
export function discoverTraceSources(options: DiscoverOptions): TraceSource[] {
  const sources: TraceSource[] = [];

  if (options.claudeCodeDir) {
    sources.push(...discoverClaudeCode(options.claudeCodeDir));
  }
  if (options.codexDir) {
    sources.push(...discoverCodex(options.codexDir));
  }
  if (options.cursorDir) {
    sources.push(...discoverCursor(options.cursorDir));
  }

  return sources;
}

/** Paths that indicate temp/ephemeral project dirs (not real repos). */
const SKIP_PATTERNS = [
  /^-private-var-folders-/,    // macOS PyInstaller temp dirs
  /^-var-folders-/,            // macOS temp dirs
  /^-tmp-/,                    // /tmp paths
  /^-private-tmp-/,            // macOS /private/tmp
  /^-temp-/,                   // Windows-style temp
  /MEIPASS/,                   // PyInstaller bundle marker
  /MEI[A-Za-z0-9]{6}/,        // PyInstaller temp dir hash
];

function isEphemeralProject(name: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(name));
}

/**
 * Walk up from a path to find the nearest .git directory.
 * Returns the git root, or the original path if no .git is found.
 */
function findGitRoot(dir: string): string {
  let current = dir;
  while (current !== "/" && current !== ".") {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dir;
}

function discoverClaudeCode(claudeDir: string): TraceSource[] {
  const projectsDir = join(claudeDir, "projects");
  if (!existsSync(projectsDir)) return [];

  const sources: TraceSource[] = [];

  for (const entry of readdirSync(projectsDir)) {
    if (isEphemeralProject(entry)) continue;

    const projectPath = join(projectsDir, entry);
    if (!statSync(projectPath).isDirectory()) continue;

    const jsonlFiles = readdirSync(projectPath).filter((f) =>
      f.endsWith(".jsonl")
    );
    if (jsonlFiles.length === 0) continue;

    // Resolve the slug back to a real path, find git root, extract repo name
    const resolvedPath = resolveRepoFromClaudeProject(entry);
    const project = resolvedPath ? basename(findGitRoot(resolvedPath)) : entry;

    sources.push({
      agent: "claude_code",
      project,
      files: jsonlFiles.map((f) => join(projectPath, f)),
    });
  }

  return sources;
}

function discoverCodex(codexDir: string): TraceSource[] {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const files = collectJsonlRecursive(sessionsDir);
  if (files.length === 0) return [];

  // Group by project cwd extracted from session_meta.
  // Each Codex session file starts with a session_meta entry containing cwd.
  const byProject = new Map<string, string[]>();
  let buf: Buffer | null = Buffer.alloc(32768);

  for (const file of files) {
    let project = "unknown";
    try {
      const fd = openSync(file, "r");
      const bytesRead = readSync(fd, buf!, 0, 32768, 0);
      closeSync(fd);
      const firstLine = buf!.toString("utf-8", 0, bytesRead).split("\n")[0];
      const entry = JSON.parse(firstLine);
      if (entry.type === "session_meta" && entry.payload?.cwd) {
        const cwd = entry.payload.cwd as string;
        // Extract repo name from path: /Users/x/dev/my-project → my-project
        project = cwd.split("/").pop() || cwd;
      }
    } catch { /* fall back to "unknown" */ }

    const existing = byProject.get(project) ?? [];
    existing.push(file);
    byProject.set(project, existing);
  }

  buf = null; // release 32KB buffer

  const sources: TraceSource[] = [];
  for (const [project, projectFiles] of byProject) {
    sources.push({
      agent: "codex",
      project,
      files: projectFiles,
    });
  }
  return sources;
}

function discoverCursor(cursorDir: string): TraceSource[] {
  const sources: TraceSource[] = [];

  // Global state.vscdb
  const globalDb = join(cursorDir, "User", "globalStorage", "state.vscdb");
  if (existsSync(globalDb)) {
    sources.push({
      agent: "cursor",
      project: "global",
      files: [globalDb],
    });
  }

  // Per-workspace state.vscdb files. Cursor stores workspace.json next to
  // state.vscdb mapping the hash to a file:// folder URI; we use that to
  // label the source with the project name (e.g. "observer") rather than
  // the opaque hash. Falls back to the hash if no mapping exists.
  const wsDir = join(cursorDir, "User", "workspaceStorage");
  if (existsSync(wsDir)) {
    for (const entry of readdirSync(wsDir)) {
      const wsDb = join(wsDir, entry, "state.vscdb");
      if (!existsSync(wsDb)) continue;
      const folder = resolveCursorWorkspacePath(cursorDir, entry);
      const project = folder ? basename(folder) : `workspace:${entry}`;
      sources.push({
        agent: "cursor",
        project,
        files: [wsDb],
      });
    }
  }

  return sources;
}

function collectJsonlRecursive(dir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectJsonlRecursive(full));
    } else if (entry.endsWith(".jsonl")) {
      results.push(full);
    }
  }

  return results;
}
