/**
 * Git event cursors — tracks the last collected date per repo.
 *
 * Stored in {stateDir}/git-cursors.json as { "owner/repo": "YYYY-MM-DD" }.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export class GitCursors {
  private cursors: Record<string, string>;
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "git-cursors.json");
    this.cursors = this.load();
  }

  private load(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Get the last collected date for a repo, or null if never collected. */
  get(repo: string): string | null {
    return this.cursors[repo] ?? null;
  }

  /** Advance the cursor for a repo to the given date. */
  set(repo: string, date: string): void {
    this.cursors[repo] = date;
  }

  /** Persist cursors to disk. */
  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.cursors, null, 2) + "\n");
  }
}
