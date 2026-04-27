/**
 * Cursor IDE SQLite parser.
 * Reads state.vscdb files and normalizes into the unified TraceEntry schema.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { TraceEntry } from "../types";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const TOOL_NAME_MAP: Record<string, string> = {
  edit_file: "edit",
  terminal: "shell",
  read_file: "read",
  search_files: "search",
  list_directory: "list",
  file_search: "search",
  grep_search: "grep",
  codebase_search: "search",
  run_terminal_command: "shell",
};

function normalizeToolName(raw: string): string {
  if (raw.startsWith("mcp__")) return raw.replace(/__/g, ":");
  return TOOL_NAME_MAP[raw] ?? raw;
}

/**
 * Infer a project name for a Cursor composer from the file paths its tool
 * calls touched. Cursor's globalStorage state.vscdb has no per-conversation
 * workspace tag, but bubble payloads contain `toolFormerData.params.targetFile`
 * / `targetDirectory` / `effectiveUri` / `path`, which give us the actual
 * working directory.
 *
 * Returns the basename of the nearest containing repo (one with a .git/ or
 * package.json), or null when there are no usable paths (pure-chat sessions
 * or paths outside the user's home).
 */
function inferProjectFromBubbles(bubbleJsonValues: string[]): string | null {
  const home = homedir();
  const paths: string[] = [];

  for (const raw of bubbleJsonValues) {
    let bubble: unknown;
    try { bubble = JSON.parse(raw); } catch { continue; }
    collectPathsFromBubble(bubble, paths, home);
    if (paths.length > 200) break; // bounded — early exit on long sessions
  }
  if (paths.length === 0) return null;

  const common = longestCommonPathPrefix(paths);
  if (!common || !common.startsWith(home)) return null;

  // First pass: walk upward looking for a real project root marker (.git or
  // package.json). Catches the typical case `~/dev/<repo>/{src,packages,...}`.
  let dir = common;
  for (let i = 0; i < 20; i++) {
    if (dir === "/" || dir === home) break;
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) {
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: parse the path relative to $HOME, skipping known "category"
  // dirs the user keeps projects under. So `~/dev/foo/src/x.ts` → "foo",
  // `~/projects/foo/x.ts` → "foo", `~/foo/x.ts` → "foo".
  const CATEGORY_DIRS = new Set(["dev", "src", "projects", "work", "code", "Code", "repos", "git"]);
  const rel = common.slice(home.length).replace(/^\/+/, "");
  if (!rel) return null;
  const segments = rel.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const idx = CATEGORY_DIRS.has(segments[0]) ? 1 : 0;
  return segments[idx] ?? null;
}

function collectPathsFromBubble(node: unknown, out: string[], home: string): void {
  if (typeof node === "string") {
    if (node.startsWith(home)) out.push(node);
    else if (node.startsWith("file://")) {
      const p = decodeURIComponent(node.slice(7));
      if (p.startsWith(home)) out.push(p);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectPathsFromBubble(v, out, home);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectPathsFromBubble(v, out, home);
  }
}

function longestCommonPathPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let i = 0;
  outer: for (; i < first.length; i++) {
    const seg = first[i];
    for (const s of split) {
      if (s[i] !== seg) break outer;
    }
  }
  // Drop a trailing partial filename segment (i.e. something with a "."),
  // since we're looking for a directory ancestor not a file.
  while (i > 0 && first[i - 1].includes(".")) i--;
  if (i === 0) return null;
  const result = first.slice(0, i).join("/");
  return result || null;
}

const EMPTY_TRACE: Omit<TraceEntry, "id" | "timestamp" | "agent" | "sessionId" | "entryType" | "role" | "developer" | "machine" | "project"> = {
  model: null, tokenUsage: null, toolName: null, toolCallId: null,
  filePath: null, command: null, taskSummary: null,
  gitRepo: null, gitBranch: null, gitCommit: null,
  userPrompt: null, assistantText: null, thinking: null, reasoning: null, systemPrompt: null,
  toolResultContent: null, fileContent: null, stdout: null, queryData: null,
};

interface ComposerData {
  composerId: string;
  createdAt?: number;
  name?: string;
  isAgentic?: boolean;
  usageData?: Record<string, { costInCents?: number }>;
}

interface BubbleData {
  bubbleId: string;
  type: number;
  text?: string;
  rawText?: string;
  tokenCount?: { inputTokens?: number; outputTokens?: number };
  toolFormerData?: Array<{
    toolName?: string;
    filePath?: string;
    command?: string;
    query?: string;
    status?: string;
  }>;
}

/**
 * Parse a Cursor state.vscdb file into TraceEntry array.
 *
 * `meta.project` is required for the dashboard's per-project filter to find
 * these entries — Cursor's state.vscdb has no project field of its own, so
 * the caller (which knows the workspace via discoverCursor's resolved
 * workspace.json) has to supply it.
 */
export function parseCursorDb(
  dbPath: string,
  meta?: { developer?: string; machine?: string; project?: string },
): TraceEntry[] {
  const db = new Database(dbPath, { readonly: true });
  const entries: TraceEntry[] = [];

  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
    .get();
  if (!tableCheck) { db.close(); return []; }

  const composerRows = db
    .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
    .all() as { key: string; value: string }[];

  for (const row of composerRows) {
    let composer: ComposerData;
    try { composer = JSON.parse(row.value); } catch { continue; }

    const sessionId = composer.composerId;
    const timestamp = composer.createdAt ? new Date(composer.createdAt).toISOString() : "";

    // Extract model + cost from usageData
    let model: string | null = null;
    if (composer.usageData) {
      const firstModel = Object.keys(composer.usageData)[0];
      if (firstModel) model = firstModel;
    }

    const bubbleRows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?")
      .all(`bubbleId:${sessionId}:%`) as { key: string; value: string }[];

    // Per-composer project: prefer the project inferred from the bubbles'
    // tool calls (file paths under the user's home dir → nearest containing
    // git repo) over the fallback meta.project. Cursor's globalStorage DB
    // pools sessions across ALL workspaces with no per-conversation tag,
    // so without this, every global-storage entry gets the same flat
    // "global" label and the dashboard's per-project filter is useless.
    const inferredProject = inferProjectFromBubbles(bubbleRows.map((b) => b.value));
    const project = inferredProject ?? meta?.project ?? "";

    const base = {
      ...EMPTY_TRACE,
      timestamp,
      agent: "cursor" as const,
      sessionId,
      model,
      developer: meta?.developer ?? "",
      machine: meta?.machine ?? "",
      project,
    };

    for (const bubbleRow of bubbleRows) {
      let bubble: BubbleData;
      try { bubble = JSON.parse(bubbleRow.value); } catch { continue; }

      const text = bubble.text ?? bubble.rawText ?? "";
      const tokenUsage = bubble.tokenCount?.inputTokens != null
        ? { input: bubble.tokenCount.inputTokens ?? 0, output: bubble.tokenCount.outputTokens ?? 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 }
        : null;

      // Tool calls
      if (bubble.toolFormerData && bubble.toolFormerData.length > 0) {
        for (const tool of bubble.toolFormerData) {
          entries.push({
            ...base,
            id: `cur:${sessionId.slice(0, 8)}:${bubble.bubbleId}:${tool.toolName ?? "?"}`,
            entryType: "tool_call",
            role: "assistant",
            toolName: normalizeToolName(tool.toolName ?? "unknown"),
            filePath: tool.filePath ?? null,
            command: tool.command ?? null,
            tokenUsage,
          });
        }
        continue;
      }

      if (!text) continue;

      if (bubble.type === 1) {
        entries.push({
          ...base,
          id: `cur:${sessionId.slice(0, 8)}:${bubble.bubbleId}`,
          entryType: "message",
          role: "user",
          userPrompt: truncate(text, 500),
          tokenUsage,
        });
      } else {
        entries.push({
          ...base,
          id: `cur:${sessionId.slice(0, 8)}:${bubble.bubbleId}`,
          entryType: "message",
          role: "assistant",
          assistantText: truncate(text, 500),
          tokenUsage,
        });
      }
    }
  }

  db.close();
  return entries;
}

// Re-export for backward compat
export type NormalizedEntry = TraceEntry;
