/**
 * Git event types — parallel entity to TraceEntry.
 *
 * Sensitivity tiers mirror TraceEntry:
 *   SAFE      — metadata, IDs, stats
 *   MODERATE  — author info, filenames, PR metadata
 *   SENSITIVE — commit body, local paths
 */

import { createHash } from "node:crypto";
import type { DisclosureLevel } from "../types";

export interface GitEvent {
  // --- SAFE ---
  id: string;
  timestamp: string;              // ISO 8601
  eventType: "commit" | "pr_open" | "pr_merge" | "pr_close";
  project: string;                // matches TraceEntry.project
  repo: string;                   // owner/repo
  branch: string;
  developer: string;
  machine: string;

  // commit
  commitSha: string | null;
  parentShas: string[] | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;

  // attribution
  agentAuthored: boolean;
  agentName: string | null;       // claude_code, codex, cursor

  // --- MODERATE ---
  author: string | null;
  authorEmail: string | null;
  coAuthors: string[] | null;
  message: string | null;         // subject line only
  files: string[] | null;
  sessionId: string | null;

  // PR
  prNumber: number | null;
  prTitle: string | null;
  prState: string | null;
  prUrl: string | null;
  prBaseBranch: string | null;
  prHeadBranch: string | null;

  // --- SENSITIVE ---
  messageBody: string | null;     // full commit body
  repoLocal: string | null;       // local filesystem path
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

const MODERATE_FIELDS: (keyof GitEvent)[] = [
  "author", "authorEmail", "coAuthors", "message", "files", "sessionId",
  "prNumber", "prTitle", "prState", "prUrl", "prBaseBranch", "prHeadBranch",
];

const SENSITIVE_FIELDS: (keyof GitEvent)[] = [
  "messageBody", "repoLocal",
];

/**
 * Strip fields above the configured disclosure tier.
 */
export function applyGitDisclosure(
  event: GitEvent,
  level: DisclosureLevel,
): GitEvent {
  const result = { ...event };

  if (level !== "sensitive" && level !== "full") {
    for (const field of SENSITIVE_FIELDS) {
      (result as Record<string, unknown>)[field] = null;
    }
  }

  if (level === "basic") {
    for (const field of MODERATE_FIELDS) {
      (result as Record<string, unknown>)[field] = null;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function gitEventId(repo: string, eventType: string, key: string): string {
  return createHash("sha256")
    .update(`${repo}:${eventType}:${key}`)
    .digest("hex")
    .slice(0, 16);
}
