/**
 * Auto-loading existing Claude Code permission settings for the
 * permissions page. Pairs with `getPermissions()` so the merge UI
 * can show "what we suggest vs what you already have" without the
 * user copy-pasting their settings file.
 *
 * Reads three places, in Claude Code's documented precedence order
 * (high → low). All three are unioned into a single `allow` list
 * because `permissions.allow` is additive — there's no precedence
 * conflict to resolve at the entry level, only at the file level.
 *
 *   1. project-local   — <repoLocal>/.claude/settings.local.json
 *   2. project-shared  — <repoLocal>/.claude/settings.json
 *   3. user-global     — ~/.claude/settings.json
 *
 * `repoLocal` is recovered from the most-recent `git_events` row for
 * the given project — the agent populates that field when scanning a
 * repo. Projects with no git activity produce no project-scoped reads,
 * but the user-global file is still tried.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query } from "./db";

export type ExistingSourceLabel = "user-global" | "project-shared" | "project-local";

export interface ExistingSource {
  label: ExistingSourceLabel;
  path: string;
  /** Number of `permissions.allow` entries this source contributed. */
  count: number;
  /** Set when the file existed but JSON parsing failed. The merge UI
   *  uses this to surface "couldn't read this file" without dropping
   *  the other valid sources. */
  error?: string;
}

export interface ExistingSettings {
  /** Unioned + deduped + sorted across all readable sources. */
  allow: string[];
  sources: ExistingSource[];
  /** The repoLocal we resolved for the project, surfaced for UI hints
   *  ("Auto-loaded from /Users/.../foo"). null when the project has no
   *  git_events. */
  repoLocal: string | null;
}

interface Opts {
  /** Override the home directory — used by tests. Defaults to `os.homedir()`. */
  homeDir?: string;
}

export async function getExistingSettings(
  project: string,
  opts: Opts = {},
): Promise<ExistingSettings> {
  const home = opts.homeDir ?? homedir();
  const repoLocal = await resolveRepoLocal(project);

  const sources: ExistingSource[] = [];
  const allowSet = new Set<string>();

  // The order we read in is also the order we surface — most-specific
  // first. The set dedupes across them; the count per source reflects
  // the entries that source *brought* (post-dedup).
  if (repoLocal) {
    tryReadInto(
      "project-local",
      join(repoLocal, ".claude", "settings.local.json"),
      sources, allowSet,
    );
    tryReadInto(
      "project-shared",
      join(repoLocal, ".claude", "settings.json"),
      sources, allowSet,
    );
  }
  tryReadInto(
    "user-global",
    join(home, ".claude", "settings.json"),
    sources, allowSet,
  );

  return {
    allow: [...allowSet].sort(),
    sources,
    repoLocal,
  };
}

async function resolveRepoLocal(project: string): Promise<string | null> {
  // Most-recent first. A project with multiple checkouts (rare but
  // possible) collapses to whichever the agent saw last; the alternative
  // would be returning all and forcing the UI to choose, which we'll
  // do later if anyone actually hits that case.
  // The project's query() helper doesn't bind parameters — it builds
  // SQL strings with single-quote escaping (see queries.ts `esc`).
  // Inline the same escape here.
  const safe = project.replace(/'/g, "''");
  const rows = await query<{ repoLocal: string | null }>(
    `SELECT repoLocal FROM git_events
     WHERE project = '${safe}' AND repoLocal IS NOT NULL
     ORDER BY timestamp DESC
     LIMIT 1`,
  );
  return rows[0]?.repoLocal ?? null;
}

function tryReadInto(
  label: ExistingSourceLabel,
  path: string,
  sources: ExistingSource[],
  allowSet: Set<string>,
): void {
  if (!existsSync(path)) return;     // file optional — silent skip
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    sources.push({ label, path, count: 0, error: `read failed: ${(e as Error).message}` });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    sources.push({ label, path, count: 0, error: `invalid JSON: ${(e as Error).message}` });
    return;
  }
  // Accept either { permissions: { allow: [...] } } or a raw array,
  // matching what we accept in the textarea path.
  let allow: unknown[] = [];
  if (Array.isArray(parsed)) {
    allow = parsed;
  } else if (parsed && typeof parsed === "object") {
    const p = (parsed as { permissions?: { allow?: unknown } }).permissions;
    if (p && Array.isArray(p.allow)) allow = p.allow;
  }
  const entries = allow.filter((s): s is string => typeof s === "string" && s.length > 0);
  let added = 0;
  for (const e of entries) {
    if (!allowSet.has(e)) {
      allowSet.add(e);
      added++;
    }
  }
  sources.push({ label, path, count: added });
}
