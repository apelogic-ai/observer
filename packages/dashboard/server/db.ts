/**
 * DuckDB data layer — reads normalized JSONL from disk.
 *
 * Creates two views:
 *   - `traces`     — agent trace entries (claude_code, codex, cursor)
 *   - `git_events` — git commit/PR events
 *
 * Both use read_json_auto with globs. New files are picked up
 * automatically on each query.
 */

import { Database } from "duckdb-async";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DATA_DIR = join(homedir(), ".observer", "traces", "normalized");

/** Agent subdirectories (everything except "git") */
const AGENT_DIRS = ["claude_code", "codex", "cursor"];

let _db: Database | null = null;
let _dataDir: string = DEFAULT_DATA_DIR;

export async function initDb(dataDir?: string): Promise<void> {
  _dataDir = dataDir ?? DEFAULT_DATA_DIR;

  if (!_db) {
    _db = await Database.create(":memory:");
  } else {
    // Rebuild: drop stale views/tables before recreating
    await _db.exec(`DROP VIEW IF EXISTS traces`);
    await _db.exec(`DROP TABLE IF EXISTS traces`);
    await _db.exec(`DROP VIEW IF EXISTS git_events`);
    await _db.exec(`DROP TABLE IF EXISTS git_events`);
  }

  if (!existsSync(_dataDir)) {
    await _db.exec(`
      CREATE TABLE traces (
        id VARCHAR, timestamp TIMESTAMP, agent VARCHAR, "sessionId" VARCHAR,
        developer VARCHAR, machine VARCHAR, project VARCHAR,
        "entryType" VARCHAR, role VARCHAR, model VARCHAR,
        "tokenUsage" STRUCT("input" BIGINT, "output" BIGINT, "cacheRead" BIGINT, reasoning BIGINT),
        "toolName" VARCHAR, "toolCallId" VARCHAR, "filePath" VARCHAR,
        command VARCHAR, "taskSummary" VARCHAR,
        "gitRepo" VARCHAR, "gitBranch" VARCHAR, "gitCommit" VARCHAR,
        "userPrompt" VARCHAR, "assistantText" VARCHAR,
        thinking VARCHAR, reasoning VARCHAR,
        "systemPrompt" VARCHAR, "toolResultContent" VARCHAR,
        "fileContent" VARCHAR, stdout VARCHAR, "queryData" VARCHAR
      )
    `);
    await _db.exec(`
      CREATE TABLE git_events (
        id VARCHAR, timestamp TIMESTAMP, "eventType" VARCHAR,
        project VARCHAR, repo VARCHAR, branch VARCHAR,
        developer VARCHAR, machine VARCHAR,
        "commitSha" VARCHAR, "parentShas" VARCHAR[],
        "filesChanged" INTEGER, insertions INTEGER, deletions INTEGER,
        "agentAuthored" BOOLEAN, "agentName" VARCHAR,
        author VARCHAR, "authorEmail" VARCHAR, "coAuthors" VARCHAR[],
        message VARCHAR, files VARCHAR[], "sessionId" VARCHAR,
        "prNumber" INTEGER, "prTitle" VARCHAR, "prState" VARCHAR,
        "prUrl" VARCHAR, "prBaseBranch" VARCHAR, "prHeadBranch" VARCHAR,
        "messageBody" VARCHAR, "repoLocal" VARCHAR
      )
    `);
    return;
  }

  // Traces: only include agent dirs that have data
  const allSubdirs = new Set<string>();
  for (const dateDir of readdirSync(_dataDir)) {
    const datePath = join(_dataDir, dateDir);
    try {
      for (const sub of readdirSync(datePath)) {
        if (AGENT_DIRS.includes(sub)) allSubdirs.add(sub);
      }
    } catch { /* not a directory */ }
  }

  const activeAgentDirs = [...allSubdirs];
  if (activeAgentDirs.length === 0) activeAgentDirs.push("claude_code"); // fallback

  const agentGlobs = activeAgentDirs
    .map((a) => join(_dataDir, "**", a, "*.jsonl").replace(/'/g, "''"));
  const traceGlobList = agentGlobs.map((g) => `'${g}'`).join(", ");

  await _db.exec(`
    CREATE VIEW traces AS
    SELECT * FROM read_json_auto(
      [${traceGlobList}],
      union_by_name = true,
      ignore_errors = true,
      maximum_object_size = 16777216
    )
  `);

  // Git events: git subdirectory
  const gitGlob = join(_dataDir, "**", "git", "*.jsonl").replace(/'/g, "''");
  const hasGitDir = readdirSync(_dataDir, { recursive: true })
    .some((f) => String(f).includes("/git/") || String(f).startsWith("git/"));

  if (hasGitDir) {
    await _db.exec(`
      CREATE VIEW git_events AS
      SELECT * FROM read_json_auto(
        '${gitGlob}',
        union_by_name = true,
        ignore_errors = true
      )
    `);
  } else {
    // Empty table so queries don't fail
    await _db.exec(`
      CREATE TABLE git_events (
        id VARCHAR, timestamp TIMESTAMP, "eventType" VARCHAR,
        project VARCHAR, repo VARCHAR, branch VARCHAR,
        developer VARCHAR, machine VARCHAR,
        "commitSha" VARCHAR, "parentShas" VARCHAR[],
        "filesChanged" INTEGER, insertions INTEGER, deletions INTEGER,
        "agentAuthored" BOOLEAN, "agentName" VARCHAR,
        author VARCHAR, "authorEmail" VARCHAR, "coAuthors" VARCHAR[],
        message VARCHAR, files VARCHAR[], "sessionId" VARCHAR,
        "prNumber" INTEGER, "prTitle" VARCHAR, "prState" VARCHAR,
        "prUrl" VARCHAR, "prBaseBranch" VARCHAR, "prHeadBranch" VARCHAR,
        "messageBody" VARCHAR, "repoLocal" VARCHAR
      )
    `);
  }
}

export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  try {
    return await (_db.all(sql) as Promise<T[]>);
  } catch (err) {
    // DuckDB views over read_json_auto break when new files change the schema.
    // Detect this and rebuild the views automatically.
    if (String(err).includes("Contents of view were altered")) {
      console.log("Schema drift detected — rebuilding views…");
      await initDb(_dataDir);
      return _db!.all(sql) as Promise<T[]>;
    }
    throw err;
  }
}

export function getDataDir(): string {
  return _dataDir;
}
