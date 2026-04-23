# Git Events: Design & Implementation Plan

Augment Observer's trace data with git history — commits, PRs, branches — as a parallel, joinable entity alongside `TraceEntry`.

## Motivation

Agent traces capture *what the agent did* (tool calls, tokens, prompts). Git history captures *what was produced* (commits, diffs, PRs). Joining the two answers questions like:

- How many lines of code did agent sessions produce this week?
- What's the agent-authored vs human-authored commit ratio?
- Which sessions led to merged PRs?
- What files do agents touch most?
- How long from session start to PR merge?

## Design Principles

1. **Parallel entity, not TraceEntry extension.** Commits and PRs have a fundamentally different shape (SHA, diff stats, parent chain) than trace entries (message, tool_call, tokens). Separate type, separate files, joinable via project + time window.

2. **Collected at scan time.** Git collection runs as part of the existing `observer scan` / daemon loop. After processing trace sources, collect git events for repos that had session activity.

3. **Local-first.** Commits come from local `git log` — no network calls required. PR data from GitHub API is optional and additive.

4. **Same partitioning.** Git events are written to the same normalized output directory structure, in a `git/` agent slot, so DuckDB picks them up with the same glob pattern or a parallel one.

## Data Model

### GitEvent

```typescript
interface GitEvent {
  // --- Identity ---
  id: string;                    // deterministic: SHA-256(repo + eventType + commitSha/prNumber)
  timestamp: string;             // ISO 8601, commit author date or PR event time
  eventType: "commit" | "pr_open" | "pr_merge" | "pr_close";

  // --- Repo ---
  project: string;               // matches TraceEntry.project (Observer's project name)
  repo: string;                  // owner/repo (e.g. "acme/observer")
  repoLocal: string;             // local path (e.g. /Users/dev/observer)
  branch: string;

  // --- Commit fields (eventType=commit) ---
  commitSha: string | null;
  parentShas: string[] | null;
  author: string | null;         // git author name
  authorEmail: string | null;    // git author email
  coAuthors: string[] | null;    // Co-Authored-By trailer values
  message: string | null;        // first line only (subject)
  messageBody: string | null;    // full body (SENSITIVE — disclosure-controlled)

  // --- Diff stats (eventType=commit) ---
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  files: string[] | null;        // paths changed

  // --- PR fields (eventType=pr_*) ---
  prNumber: number | null;
  prTitle: string | null;
  prState: string | null;        // open, merged, closed
  prUrl: string | null;
  prBaseBranch: string | null;   // e.g. main
  prHeadBranch: string | null;   // e.g. feat/foo

  // --- Attribution ---
  agentAuthored: boolean;        // inferred from Co-Authored-By or commit pattern
  agentName: string | null;      // which agent (claude_code, codex) if agent-authored
  sessionId: string | null;      // linked session (best-effort, from time window match)

  // --- Sensitivity ---
  developer: string;             // same as TraceEntry.developer
  machine: string;
}
```

### Sensitivity Classification

| Tier | Fields |
|------|--------|
| SAFE | id, timestamp, eventType, project, repo, branch, commitSha, parentShas, filesChanged, insertions, deletions, agentAuthored, agentName, developer, machine |
| MODERATE | author, authorEmail, coAuthors, message (subject line), files, prNumber, prTitle, prState, prUrl, prBaseBranch, prHeadBranch, sessionId |
| SENSITIVE | messageBody (full commit body), repoLocal |

Same disclosure policy as TraceEntry — fields above the configured tier are stripped before writing.

### Agent Attribution Heuristics

A commit is marked `agentAuthored: true` when any of:
1. `Co-Authored-By` trailer contains "Claude", "Anthropic", "Codex", "OpenAI", "Cursor"
2. Author name/email matches known agent patterns (e.g. `noreply@anthropic.com`)
3. Commit was created during an active agent session on the same project + branch (time window match)

Heuristic 3 is weaker — a human could commit during a session. Heuristics 1-2 are definitive. The `agentName` field is set from the matched pattern.

### Session Linking

Best-effort join: a GitEvent links to a session when:
- `project` matches
- `branch` matches (or session's branch is unknown)
- `timestamp` falls within the session's `[started, ended]` window (with a small buffer, e.g. ±5 minutes for post-session commits)

This linkage happens at query time (DuckDB join), not at collection time. The `sessionId` field on GitEvent is optional — populated only when the collector has high confidence (e.g., commit created by a tool_call within the session's trace).

## Storage

### Directory Structure

```
~/.observer/traces/normalized/
    2026-04-22/
        claude_code/*.jsonl     # agent traces (existing)
        codex/*.jsonl
        git/                    # NEW: git events
            {repo-hash}.jsonl   # one file per repo per day
```

`{repo-hash}` is a short hash of the repo identifier (e.g., first 12 chars of SHA-256 of `owner/repo`). One file per repo per day keeps files small and avoids cross-repo mixing.

Each line is one `GitEvent` JSON object (JSONL), same as TraceEntry files.

### DuckDB Integration

New view alongside `traces`:

```sql
CREATE VIEW git_events AS
SELECT * FROM read_json_auto(
  '~/.observer/traces/normalized/**/git/*.jsonl',
  union_by_name = true,
  ignore_errors = true
);
```

### Example Queries

```sql
-- Commits per day, agent vs human
SELECT
  CAST(timestamp AS DATE) AS day,
  agentAuthored,
  COUNT(*) AS commits,
  SUM(insertions) AS lines_added,
  SUM(deletions) AS lines_removed
FROM git_events
WHERE eventType = 'commit'
GROUP BY day, agentAuthored
ORDER BY day;

-- Sessions that produced commits
SELECT
  s.session_id, s.agent, s.project,
  COUNT(g.commitSha) AS commits,
  SUM(g.insertions) AS lines_added
FROM (
  SELECT "sessionId" AS session_id, agent, project,
         MIN(timestamp) AS started, MAX(timestamp) AS ended
  FROM traces GROUP BY "sessionId", agent, project
) s
JOIN git_events g
  ON g.project = s.project
  AND g.timestamp BETWEEN s.started AND s.ended
  AND g.eventType = 'commit'
GROUP BY s.session_id, s.agent, s.project;

-- Top files changed by agents
SELECT unnest(files) AS file, COUNT(*) AS times_changed
FROM git_events
WHERE agentAuthored = true AND eventType = 'commit'
GROUP BY file ORDER BY times_changed DESC LIMIT 20;
```

## Collection

### Source 1: Local Git (commits, branches)

Runs during `observer scan`. For each project that had trace activity:

1. Resolve project name → local repo path (reuse `repo-resolver.ts`)
2. Determine time window: earliest trace timestamp for this scan period
3. Run `git log` with structured format:

```bash
git -C /path/to/repo log \
  --after="2026-04-22T00:00:00" \
  --before="2026-04-23T00:00:00" \
  --all \
  --format="%H%n%P%n%an%n%ae%n%s%n%b%n---COMMIT_END---" \
  --numstat
```

4. Parse output into `GitEvent[]`
5. Extract `Co-Authored-By` from commit body for attribution
6. Apply disclosure policy (strip fields above configured tier)
7. Write to `{date}/git/{repo-hash}.jsonl`

### Source 2: GitHub API (PRs) — optional

If `gh` CLI is available and authenticated:

```bash
gh api repos/{owner}/{repo}/pulls \
  --jq '.[] | {number, title, state, head: .head.ref, base: .base.ref, merged_at, created_at, html_url}' \
  -f state=all -f sort=updated -f direction=desc -f per_page=30
```

Only fetches PRs updated within the scan window. Creates `pr_open`, `pr_merge`, `pr_close` events.

PR collection is gated behind a config flag:

```yaml
git:
  enabled: true
  collectPRs: true       # requires gh CLI + auth
  repos: []              # empty = auto-detect from traces
```

### Cursor Tracking

Git events use their own cursor file to avoid re-collecting:

```
~/.observer/git-cursors.json
{
  "acme/observer": "2026-04-22",    // last collected date per repo
  "acme/dashboard": "2026-04-21"
}
```

On each scan, collect from `lastDate + 1` through today.

## Implementation Plan

All work in `packages/agent/`. No new package.

### Phase 1: Core — local commit collection

| Step | File | What |
|------|------|------|
| 1 | `src/git/types.ts` | `GitEvent` interface, sensitivity tiers, disclosure filter |
| 2 | `src/git/collector.ts` | `collectGitEvents(repoPath, since, until): GitEvent[]` — runs `git log`, parses output, detects agent attribution |
| 3 | `src/git/writer.ts` | `writeGitEvents(outputDir, date, repoHash, events)` — writes JSONL with disclosure filtering |
| 4 | `src/git/cursors.ts` | Per-repo date cursor tracking (analogous to shipper cursors) |
| 5 | `tests/git/collector.test.ts` | Unit tests: parse git log output, agent attribution heuristics, edge cases (merge commits, empty commits) |
| 6 | `tests/git/writer.test.ts` | Unit tests: JSONL output, disclosure filtering |

### Phase 2: Integration with scan pipeline

| Step | File | What |
|------|------|------|
| 7 | `src/git/scanner.ts` | `scanGitEvents(opts)` — top-level function: resolve active repos from traces, run collector for each, write results. Called from scan/daemon. |
| 8 | `src/cli.ts` | Add `--collect-git` flag to `scan` command. Call `scanGitEvents` after trace processing. |
| 9 | `src/config.ts` | Add `git: { enabled, collectPRs }` to `ObserverConfig` |
| 10 | `src/daemon.ts` | Call git collection in daemon loop when enabled |
| 11 | `tests/git/scanner.test.ts` | Integration test: mock git repos with known commits, verify JSONL output |

### Phase 3: GitHub PR collection (optional)

| Step | File | What |
|------|------|------|
| 12 | `src/git/github.ts` | `collectPREvents(owner, repo, since): GitEvent[]` — calls `gh api`, parses PR data |
| 13 | `src/git/scanner.ts` | Integrate PR collection when `collectPRs: true` and `gh` is available |
| 14 | `tests/git/github.test.ts` | Unit tests with mock `gh` output |

### Phase 4: Dashboard + MCP integration

| Step | File | What |
|------|------|------|
| 15 | `packages/dashboard/server/db.ts` | Add `git_events` view |
| 16 | `packages/dashboard/server/queries.ts` | Add git query functions: `getCommitStats`, `getAgentAttribution`, `getCommitTimeline` |
| 17 | `packages/dashboard/server/index.ts` | Add `/api/git-stats`, `/api/git-commits` routes |
| 18 | MCP server | Add `observer_git_stats`, `observer_git_commits` tools (when MCP is built) |

### Phase 5: Dashboard UI (future)

Git stats cards, commit timeline overlaid on activity chart, agent attribution pie chart. Design TBD after data is flowing.

## Config Extension

```yaml
# ~/.observer/config.yaml
git:
  enabled: true              # collect git events during scan
  collectPRs: false          # requires gh CLI, default off
  attributionPatterns:       # custom patterns for agent detection
    - "Co-Authored-By:.*Claude"
    - "Co-Authored-By:.*Anthropic"
    - "Co-Authored-By:.*Codex"
    - "Co-Authored-By:.*Cursor"
```

## Open Questions

1. **Diff content.** Should we capture actual diff content (patch), or just stats (files, insertions, deletions)? Diffs are valuable for Dreamer (knowledge extraction) but are potentially large and sensitive. Current proposal: stats only at MODERATE, full patch at SENSITIVE.

2. **Historical backfill.** On first run, should we backfill git history to match the trace data range? Or only collect forward from first scan? Proposal: backfill to match the earliest trace date in normalized output.

3. **Monorepo handling.** A single repo can map to multiple Observer projects (e.g., `packages/agent` and `packages/dashboard` in the observer repo). Git events would be collected once per repo but the `project` field would need to reflect the correct sub-project. May need per-file attribution using the `files` array.

4. **Branch tracking.** Should we track branch create/delete/merge events beyond what's captured in commits and PRs? These are lightweight events that show workflow patterns. Defer to Phase 3+.
