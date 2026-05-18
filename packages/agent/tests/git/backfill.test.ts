import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { backfillGitHistory } from "../../src/git/scanner";

/**
 * `backfillGitHistory({ since, repos, ... })` is the one-shot path
 * for pulling git history that predates observer's incremental
 * scanner. It walks every configured repo from `since` up to the
 * current cursor (or today if no cursor exists) and writes the
 * commits to the same date-partitioned JSONL output the live
 * scanner uses. The forward cursor is left alone — backfill fills
 * history BEHIND the cursor only.
 */

function tmpRepoWithHistory(opts: {
  remote: string;
  dates: string[];
  authorEmail: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "observer-backfill-repo-"));
  execSync("git init -q", { cwd: dir });
  execSync(`git remote add origin ${opts.remote}`, { cwd: dir });
  execSync(`git config user.email "${opts.authorEmail}"`, { cwd: dir });
  execSync(`git config user.name "Test User"`, { cwd: dir });
  opts.dates.forEach((date, i) => {
    writeFileSync(join(dir, `f${i}.txt`), `content ${i}\n`);
    execSync(`git add f${i}.txt`, { cwd: dir });
    const env = { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` };
    execSync(`git commit -q -m "commit ${i}"`, { cwd: dir, env });
  });
  return dir;
}

function readGitDates(outputDir: string): string[] {
  return readdirSync(outputDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

function readGitEvents(outputDir: string, date: string): Array<Record<string, unknown>> {
  const dir = join(outputDir, date, "git");
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const events: Array<Record<string, unknown>> = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

describe("backfillGitHistory", () => {
  it("collects commits from `since` up to today when no cursor exists", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "observer-backfill-out-"));
    const stateDir = mkdtempSync(join(tmpdir(), "observer-backfill-state-"));
    const repoPath = tmpRepoWithHistory({
      remote: "git@github.com:acme/old.git",
      dates: ["2024-06-01", "2025-01-15", "2025-12-31"],
      authorEmail: "me@example.com",
    });

    const written = backfillGitHistory({
      since: "2024-01-01",
      repos: [{ project: "old", localPath: repoPath, repo: "acme/old" }],
      outputDir,
      stateDir,
      disclosure: "full",
      developer: "me@example.com",
      machine: "host",
    });

    expect(written).toBe(3);
    const dates = readGitDates(outputDir);
    expect(dates).toEqual(["2024-06-01", "2025-01-15", "2025-12-31"]);
  });

  it("respects `since` — commits older than it are skipped", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "observer-backfill-out-"));
    const stateDir = mkdtempSync(join(tmpdir(), "observer-backfill-state-"));
    const repoPath = tmpRepoWithHistory({
      remote: "git@github.com:acme/old.git",
      dates: ["2024-01-01", "2025-06-01"],
      authorEmail: "me@example.com",
    });

    const written = backfillGitHistory({
      since: "2025-01-01",
      repos: [{ project: "old", localPath: repoPath, repo: "acme/old" }],
      outputDir,
      stateDir,
      disclosure: "full",
      developer: "me@example.com",
      machine: "host",
    });

    expect(written).toBe(1);
    expect(readGitDates(outputDir)).toEqual(["2025-06-01"]);
  });

  it("stops at the existing forward cursor — never overwrites incremental data", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "observer-backfill-out-"));
    const stateDir = mkdtempSync(join(tmpdir(), "observer-backfill-state-"));
    const repoPath = tmpRepoWithHistory({
      remote: "git@github.com:acme/old.git",
      dates: ["2024-06-01", "2025-01-15", "2025-12-31"],
      authorEmail: "me@example.com",
    });

    // Pretend incremental has already collected from 2025-06-01 onward.
    writeFileSync(
      join(stateDir, "git-cursors.json"),
      JSON.stringify({ "acme/old": "2025-06-01" }, null, 2) + "\n",
    );

    const written = backfillGitHistory({
      since: "2024-01-01",
      repos: [{ project: "old", localPath: repoPath, repo: "acme/old" }],
      outputDir,
      stateDir,
      disclosure: "full",
      developer: "me@example.com",
      machine: "host",
    });

    // Only the pre-cursor commit (2024-06-01) and same-day-as-cursor-
    // minus-one (2025-01-15) should land; 2025-12-31 is post-cursor.
    expect(written).toBe(2);
    expect(readGitDates(outputDir)).toEqual(["2024-06-01", "2025-01-15"]);
  });

  it("leaves the forward cursor untouched (backfill is a separate axis from incremental)", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "observer-backfill-out-"));
    const stateDir = mkdtempSync(join(tmpdir(), "observer-backfill-state-"));
    const repoPath = tmpRepoWithHistory({
      remote: "git@github.com:acme/old.git",
      dates: ["2024-06-01"],
      authorEmail: "me@example.com",
    });

    writeFileSync(
      join(stateDir, "git-cursors.json"),
      JSON.stringify({ "acme/old": "2025-06-01" }, null, 2) + "\n",
    );

    backfillGitHistory({
      since: "2024-01-01",
      repos: [{ project: "old", localPath: repoPath, repo: "acme/old" }],
      outputDir,
      stateDir,
      disclosure: "full",
      developer: "me@example.com",
      machine: "host",
    });

    const cursors = JSON.parse(readFileSync(join(stateDir, "git-cursors.json"), "utf-8")) as Record<string, string>;
    expect(cursors["acme/old"]).toBe("2025-06-01");
  });

  it("drops other authors' commits by default (matches incremental's onlySelf default)", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "observer-backfill-out-"));
    const stateDir = mkdtempSync(join(tmpdir(), "observer-backfill-state-"));
    const dir = mkdtempSync(join(tmpdir(), "observer-backfill-mixed-"));
    execSync("git init -q", { cwd: dir });
    execSync(`git remote add origin git@github.com:acme/old.git`, { cwd: dir });
    execSync(`git config user.email "me@example.com"`, { cwd: dir });
    execSync(`git config user.name "Me"`, { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a\n");
    execSync(`git add a.txt`, { cwd: dir });
    execSync(`git commit -q -m "mine"`, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: "2024-06-01T12:00:00Z", GIT_COMMITTER_DATE: "2024-06-01T12:00:00Z" },
    });
    execSync(`git config user.email "teammate@example.com"`, { cwd: dir });
    execSync(`git config user.name "Teammate"`, { cwd: dir });
    writeFileSync(join(dir, "b.txt"), "b\n");
    execSync(`git add b.txt`, { cwd: dir });
    execSync(`git commit -q -m "theirs"`, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: "2024-06-02T12:00:00Z", GIT_COMMITTER_DATE: "2024-06-02T12:00:00Z" },
    });

    const written = backfillGitHistory({
      since: "2024-01-01",
      repos: [{ project: "old", localPath: dir, repo: "acme/old" }],
      outputDir,
      stateDir,
      disclosure: "full",
      developer: "me@example.com",
      machine: "host",
    });

    expect(written).toBe(1);
    const events = readGitEvents(outputDir, "2024-06-01");
    expect(events).toHaveLength(1);
    expect((events[0] as { authorEmail: string }).authorEmail).toBe("me@example.com");
  });
});
