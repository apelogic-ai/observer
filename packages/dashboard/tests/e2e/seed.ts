/**
 * Generate a deterministic trace fixture under tests/e2e/fixtures/data.
 *
 * Layout mirrors what the agent's disk-shipper produces:
 *   <date>/<agent>/<sessionHash>.jsonl
 *
 * Two days, three agents, with cursor having a token sidecar so we can
 * exercise the API-augmented path that motivated this whole work.
 *
 * Why a global setup file instead of a per-test fixture: the dashboard
 * server reads from OBSERVER_DATA_DIR at start, and we keep one server
 * instance for the whole suite (workers=1).
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(__dirname, "fixtures/data");

interface Entry {
  id: string;
  timestamp: string;
  agent: string;
  sessionId: string | null;
  project: string | null;
  entryType: string;
  model: string | null;
  tokenUsage: Record<string, number> | null;
  toolName: string | null;
  developer: string;
  machine: string;
}

function entry(o: Partial<Entry> & { id: string; timestamp: string; agent: string }): Entry {
  return {
    sessionId: null, project: null, entryType: "message", model: null,
    tokenUsage: null, toolName: null,
    developer: "test@example.com", machine: "test-host",
    ...o,
  };
}

function writeJsonl(path: string, rows: Entry[] | Record<string, unknown>[]) {
  const dir = join(path, "..");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const exists = existsSync(path);
    const sz = exists ? statSync(path).size : -1;
    console.log(`[seed] wrote ${path} (${rows.length} rows, ${sz}B, exists=${exists})`);
  } catch (err) {
    console.log(`[seed] FAILED ${path}: ${(err as Error).message}`);
    throw err;
  }
}

export default async function globalSetup() {
  // CI log so we can see in the workflow output that seed actually
  // executed and where it wrote the fixture. The v0.1.13 first attempt
  // had the diag probe show traceRows:0; this tells us if seed ran at
  // all and whether the path matches the dashboard's data_dir.
  console.log(`[seed] FIXTURE_ROOT=${FIXTURE_ROOT}`);
  console.log(`[seed] cwd=${process.cwd()}`);

  // Wipe and recreate so re-runs are deterministic.
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true });
  mkdirSync(FIXTURE_ROOT, { recursive: true });

  const D1 = "2026-04-25";
  const D2 = "2026-04-26";

  // --- claude_code: two sessions on D1, one on D2 (alpha + beta projects) ---
  writeJsonl(join(FIXTURE_ROOT, D1, "claude_code", "s-alpha.jsonl"), [
    entry({ id: "c1", timestamp: `${D1}T10:00:00Z`, agent: "claude_code",
            sessionId: "claude-alpha-1", project: "alpha", model: "claude-opus-4-7",
            tokenUsage: { input: 1000, output: 500, cacheRead: 50000, cacheCreation: 100, reasoning: 0 } }),
    entry({ id: "c2", timestamp: `${D1}T10:01:00Z`, agent: "claude_code",
            sessionId: "claude-alpha-1", project: "alpha", entryType: "tool_call",
            toolName: "Bash" }),
  ]);
  writeJsonl(join(FIXTURE_ROOT, D2, "claude_code", "s-beta.jsonl"), [
    entry({ id: "c3", timestamp: `${D2}T11:00:00Z`, agent: "claude_code",
            sessionId: "claude-beta-1", project: "beta", model: "claude-opus-4-7",
            tokenUsage: { input: 2000, output: 800, cacheRead: 80000, cacheCreation: 200, reasoning: 0 } }),
  ]);

  // --- codex: one session on D2 (alpha) ---
  writeJsonl(join(FIXTURE_ROOT, D2, "codex", "s-alpha.jsonl"), [
    entry({ id: "x1", timestamp: `${D2}T12:00:00Z`, agent: "codex",
            sessionId: "codex-alpha-1", project: "alpha", model: "gpt-5.4",
            tokenUsage: { input: 5000, output: 1200, cacheRead: 0, cacheCreation: 0, reasoning: 0 } }),
  ]);

  // --- cursor: one bubble session on D2 with zero local tokens (Cursor's
  //     local DB always reports 0). The sidecar below carries the real
  //     numbers from the API, replacing the zeros in aggregate views. ---
  writeJsonl(join(FIXTURE_ROOT, D2, "cursor", "s-cursor.jsonl"), [
    entry({ id: "u1", timestamp: `${D2}T13:00:00Z`, agent: "cursor",
            sessionId: "cursor-alpha-1", project: "alpha",
            tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 } }),
  ]);
  writeFileSync(
    join(FIXTURE_ROOT, D2, "cursor", "_usage.json"),
    JSON.stringify({
      v: 1,
      date: D2,
      fetchedAt: new Date().toISOString(),
      totals: {
        input: 12000, output: 3500, cacheRead: 80000, cacheCreation: 0, reasoning: 0,
        costCents: 4.2, modelIntents: ["default"],
      },
    }, null, 2),
  );

  // --- git_events on D1 (alpha repo) ---
  // g1 (deadbeef): timestamp matches the claude-alpha-1 trace at 10:00,
  //   already has sessionId set on disk — straight-through.
  // g2 (cafebabe): timestamp at 10:01, sessionId NULL on disk but its
  //   timestamp falls inside the claude-alpha-1 window. The dashboard's
  //   backfill should link it. Lets the e2e exercise sibling-commit
  //   rendering on the commit page.
  // g3 (feedface): pure human commit at 09:00 with no session match.
  //   Stays unlinked (Session column shows "—").
  writeJsonl(join(FIXTURE_ROOT, D1, "git", "alpha.jsonl"), [
    {
      id: "g1", timestamp: `${D1}T10:00:30Z`, eventType: "commit",
      project: "alpha", repo: "acme/alpha", branch: "main",
      developer: "test@example.com", machine: "test-host",
      commitSha: "deadbeef", parentShas: [], filesChanged: 1,
      insertions: 10, deletions: 2,
      agentAuthored: true, agentName: "claude_code",
      author: "Test Dev", authorEmail: "test@example.com", coAuthors: [],
      message: "feat: agent-authored sibling A",
      files: ["README.md"], sessionId: "claude-alpha-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      id: "g2", timestamp: `${D1}T10:00:45Z`, eventType: "commit",
      project: "alpha", repo: "acme/alpha", branch: "main",
      developer: "test@example.com", machine: "test-host",
      commitSha: "cafebabe", parentShas: [], filesChanged: 2,
      insertions: 25, deletions: 5,
      agentAuthored: true, agentName: "claude_code",
      author: "Test Dev", authorEmail: "test@example.com", coAuthors: [],
      message: "feat: agent-authored sibling B (Co-Authored-By, no sessionId)",
      files: ["src/foo.ts"], sessionId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      id: "g3", timestamp: `${D1}T09:00:00Z`, eventType: "commit",
      project: "alpha", repo: "acme/alpha", branch: "main",
      developer: "test@example.com", machine: "test-host",
      commitSha: "feedface", parentShas: [], filesChanged: 1,
      insertions: 3, deletions: 1,
      agentAuthored: false, agentName: null,
      author: "Test Dev", authorEmail: "test@example.com", coAuthors: [],
      message: "human commit, unlinked",
      files: ["docs.md"], sessionId: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  ]);

  // The dashboard's foreign-commit filter would otherwise drop these test
  // commits (their author doesn't match a real developer in config.yaml).
  // The test entrypoint sets OBSERVER_SKIP_FOREIGN_FILTER=1 already; we
  // just need to be sure it's set before the server boots.
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";

  // Verify the fixture actually got written. Helps diagnose CI failures
  // where the dashboard server scans an empty/missing dir despite seed
  // appearing to complete.
  function tree(dir: string, depth = 0): string {
    if (!existsSync(dir)) return `${"  ".repeat(depth)}${dir} [MISSING]`;
    const lines: string[] = [];
    const items = readdirSync(dir);
    for (const item of items) {
      const full = join(dir, item);
      const stat = statSync(full);
      lines.push(`${"  ".repeat(depth)}${item}${stat.isDirectory() ? "/" : ` (${stat.size}B)`}`);
      if (stat.isDirectory()) lines.push(tree(full, depth + 1));
    }
    return lines.filter(Boolean).join("\n");
  }
  console.log(`[seed] fixture tree:\n${tree(FIXTURE_ROOT)}`);
}
