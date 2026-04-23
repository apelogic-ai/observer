/**
 * Git event writer — writes GitEvent JSONL to the normalized output directory.
 *
 * Output: {outputDir}/{YYYY-MM-DD}/git/{repoHash}.jsonl
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyGitDisclosure, type GitEvent } from "./types";
import type { DisclosureLevel } from "../types";

/**
 * Hash a repo identifier to a short filename-safe string.
 */
export function repoHash(repo: string): string {
  return createHash("sha256").update(repo).digest("hex").slice(0, 12);
}

/**
 * Group events by date (from their timestamp).
 */
function groupByDate(events: GitEvent[]): Map<string, GitEvent[]> {
  const byDate = new Map<string, GitEvent[]>();
  for (const e of events) {
    const date = e.timestamp.slice(0, 10); // YYYY-MM-DD from ISO 8601
    const bucket = byDate.get(date) ?? [];
    bucket.push(e);
    byDate.set(date, bucket);
  }
  return byDate;
}

export interface WriteOptions {
  outputDir: string;
  disclosure: DisclosureLevel;
}

/**
 * Write git events to JSONL files, partitioned by date.
 * Returns the number of events written.
 */
export function writeGitEvents(
  events: GitEvent[],
  repo: string,
  opts: WriteOptions,
): number {
  if (events.length === 0) return 0;

  const hash = repoHash(repo);
  const byDate = groupByDate(events);
  let total = 0;

  for (const [date, dateEvents] of byDate) {
    const dir = join(opts.outputDir, date, "git");
    mkdirSync(dir, { recursive: true });

    const lines = dateEvents.map((e) => {
      const filtered = applyGitDisclosure(e, opts.disclosure);
      return JSON.stringify(filtered);
    });

    writeFileSync(join(dir, `${hash}.jsonl`), lines.join("\n") + "\n");
    total += lines.length;
  }

  return total;
}
