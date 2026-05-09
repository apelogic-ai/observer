# Improvement backlog

Captured 2026-05-06 from a data-driven review of the local trace store
(2178 JSONL files, 142,969 trace rows, 1,822 git rows, 1,747 sessions,
28 projects, 2026-02-02 → 2026-05-07).

Items are kept here, not in commit messages or PR descriptions, so
their motivation survives once they ship and so the order can be
revisited.

## 1. Commit attribution health (foundational)

**Finding.** 1,822 commits total · 564 marked agent-authored · only 223
linked to sessions. ~341 orphan agent-authored commits sit unattached.
About 80 sessions plausibly cover those orphans by timestamp window.

**Why it matters.** Every session-level metric (zero-code, dark-spend,
future productivity score) divides by "linked agent commits." Today
that denominator misses ~60% of agent activity, so the published numbers
are understated by an unknown factor that varies per project and per
window.

**Scope, in order:**
1. Surface "unlinked agent commits" as a first-class metric — count +
   ratio, broken down by project and by week. Make the gap visible
   before trying to close it.
2. Then iterate on the backfill heuristic in `packages/agent/src/git/scanner.ts`
   (timestamp window, branch overlap, Co-Authored-By trailer matching).
3. Re-scan + verify the ratio drops.

**Sub-bug found and fixed.** The dashboard's ingest-time session
backfill used to promote ANY orphan commit matching a session's
project + timestamp window to `agentAuthored = 1`, including human
commits the user happened to make during an agent session — that
silently inflated `agent_commits` by ~35% on the live data (279 of
787 previously-tagged commits were actually human). The backfill
now narrows its target to commits already tagged agent-authored at
scan time; ratio integrity is restored.

**Step 2 status (cross-project + activity-window backfill).** Done
in the same workstream:

- session.project ≠ commit.project no longer blocks attribution. A
  second pass keys on `agentName` + nearest tool-call activity
  (±60min window, closest-activity-wins, ties abstain). Catches the
  diagnosed "Claude Code launched from db-mcp shells into boost-dbt
  and commits" pattern.
- The remaining ~6 orphans on the live dashboard need >2h-out
  matching to find any candidate. We tested wider windows and they
  start producing coincidental links; left as legitimate gaps.

Coverage went 97.5% → 98.8% with the corrected denominator.

**Open: agent-side scanner has the same promotion bug.**
`packages/agent/src/git/scanner.ts:259` (`attributeFromSessions`)
flips `agentAuthored=true` on any commit that falls inside a
session window. Same shape as the dashboard backfill bug, but it
runs at scan time so the false positives end up in normalized
on-disk data — my dashboard-side fix only stops new promotions, not
historical ones.

Particularly bad for codex: codex doesn't write `Co-Authored-By`
trailers, so 100% of its 211 "agent commits" in the live data are
attributed via this session-window heuristic. Until the agent is
patched and a re-scan runs, "codex agent commits" includes humans
who happened to commit during a codex session.

Fixing this is an agent-side change (separate package) plus a
forced re-scan. Out of scope for the dashboard PR; tracked here so
it surfaces when item #2 (parser changes) gets picked up — that
work also needs a re-scan, so the two could ship together.

**Boundary.** Don't conflate this with the validation panel or any
new productivity card. One PR per behaviour change.

## 2. Tool-result instrumentation: exitCode, durationMs, success

**Done.** Trace schema extended with `exitCode`, `durationMs`,
`success` on tool_result rows. Both parsers updated:

- **Codex** — `exit_code` and wall time are NOT structured fields;
  they're embedded in the function-call-output text envelope
  (`Process exited with code N` / `Wall time: N seconds`). Parser
  regexes them out. Outputs that didn't go through the shell wrapper
  (custom tools / older formats) get null fields rather than guesses.
- **Claude Code** — `success` derived from `is_error` when set;
  falls back to substring scan over the truncated result text when
  the field is missing on older traces. `exitCode` / `durationMs`
  stay null (the protocol carries no structured equivalents).

Distribution after re-scan on the live store:

  claude_code  success=true 9,900 (95%)  false 394 (4%)   null 79 (1%)
  codex        success=true 28,669 (75%) false 2,797 (7%) null 6,622 (17%)

The 7% codex failure rate is real downstream signal — opens up #4
(failed-command loop detector) cleanly. Codex's ~17% null bucket is
older shell wrappers without the `Process exited with code` line;
worth a follow-up pass if it stays a meaningful fraction of new data.

**Substring fallback for claude:** kept in the parser as a degraded
signal when `is_error` isn't present. The dashboard SQL never
substring-matched directly (verified via grep), so no downstream
substitution was needed.

## 3. Validation after final edit (highest user-facing ROI)

**Finding.** 264 sessions ran *some* validation command. 158 sessions
edited code but didn't run validation after the last edit. Only ~2 of
the linked code-producing sessions clearly validated post-edit.

**Why it matters.** "Did the agent verify its own work before
finishing?" is the single highest-signal session-quality flag we don't
have today. Cheap to compute, demoable, complements the existing
permissions + skills pages.

**Definition of validation.** Tool calls matching:
- `Bash` / `shell` with verb in `{npm test, bun test, pytest, cargo test,
  go test, lint, typecheck, eslint, tsc, ruff, mypy, vitest, playwright}`
- Custom-named test/lint commands (use a config-driven list, not a
  hard-coded one)
- File tools (Edit, Read, Write) explicitly do NOT count.

**Scope:**
1. New SQL: `getValidationCoverage(filters)` returns per-session
   `{ sessionId, lastEditAt, lastValidationAt, validatedAfterEdit, … }`.
2. New page `/validation` (or panel on overview) — table of sessions
   that edited code but skipped validation, sorted by tokens spent.
3. No drilldown for v1.

**Doesn't need item 2.** Pure tool-name + ordering — exit codes don't
matter for "did they run it"; a separate later pass can use exit codes
to ask "did it pass."

**Status: shipped.** New `/validation` page with summary cards (total
edited / validated / un-validated / tokens spent) plus a per-session
table sorted un-validated-first then by tokens descending. Edit
detection covers Edit/Write/MultiEdit/apply_patch; validation
matches Bash/shell `command` LIKE-prefix patterns from a hardcoded
list (bun/npm/yarn/pnpm test+lint+typecheck+build, pytest, vitest,
playwright, eslint, tsc, ruff, mypy, cargo, go, make, just). Live
state on the local store: **23% coverage** — 26 sessions edited
code, only 6 validated afterwards, ~2.4B tokens of un-validated
spend. Config-driven pattern list deferred to follow-up.

## 4. Validation-loop detector ("stuck agent" signal)

**Status: shipped** as a second card on `/validation`. Per
(sessionId, command) row, surfaces validation invocations where the
same test/lint/build/typecheck command ran ≥3 times in one session.
Failure count is read from PR #25's `success` column on tool_result
rows joined to the call by toolCallId, so the table distinguishes
"ran the suite a few times on purpose" from "stuck on a red test."

Live state: 156 loops detected. Worst cases include `bun run build`
× 16 (9 failures) and `bun run test` × 25 (7 failures) — exactly
the shapes the original review flagged (200-456 validation commands
in single sessions).

**Simplification vs original spec:** we don't enforce strict
T → E → T → E ordering or "edit to same file between attempts."
Repetition + failure rate already tells the story; ordering checks
add complexity without much marginal signal on the live data.

## 5. User intervention rate (autonomy score)

**Status: shipped** as new `/autonomy` page. Per-session row of
user-turn count + tool calls + commits + LoC + tokens, plus three
derived ratios:
- **tools per turn** — high = autonomous (a lot done per nudge),
  low = stalling
- **turns per commit** — null when no commits
- **turns per LoC** — null when no LoC

Sorted user-turn-desc so the most-handheld sessions land at top.
Live state: 1,241 sessions with user turns. Top 8 are all codex /
db-mcp with 80–124 turns each — same project pattern as the
boost-dbt commit-attribution oddity. Most-autonomous claude_code
sessions hit ~190 tool calls per turn.

## 6. Search-to-edit ratio (navigation friction)

One real example: 403 searches vs 58 edits, 148M tokens. High
read/grep/find activity before a small edit suggests the repo lacks
discoverable structure / docs / tests.

Compute per-session ratio of `(read-shaped tools) / (edit-shaped tools)`.
Pure SQL on existing data.

## 7. First-useful-action latency

Some sessions waited 20–60+ minutes before first edit. Measure
elapsed-time from first user message to first edit / test / commit.
Identifies sessions where the agent over-explored before acting.

Pure SQL on existing data.

## UX: sortable + indicated tables

**Cross-cutting** — observed while scanning /autonomy: every table
on the dashboard hard-codes its sort order and gives no UI signal
that the column it ranks by is *the* sort column. Two missing UX
affordances:

- **Sort indicator.** The column the table is ranked by should
  carry an arrow / chevron showing direction.
- **Click-to-sort.** Each column header should be clickable to
  re-sort by that column. Currently every page bakes "rank by X
  desc" into the SQL — useful as a default, but a user comparing
  sessions across three different metrics has to re-query.

Lift the table primitive into a shared component and add both. The
existing pages (sessions, dark-spend, zero-code, security, skills,
permissions, validation, autonomy, …) all benefit. Likely a single
PR that introduces the primitive and migrates one page, then a
follow-up sweep.

## 8. Per-session productivity score (composite)

Combine #1, #2, #3, #4, #5, #6, #7 into a single sortable column:

- linked commits, LoC delta
- validation after final edit (bool)
- active minutes / tokens spent
- stumbles / failed-command-loops
- user-intervention count

Bucket sessions into "productive", "expensive but productive", "stuck",
"needs better setup". This is the *last* thing to ship — a score is
only meaningful once its inputs are trustworthy.

## Order

1. → 2. → 3. (ship as separate PRs in sequence)
4. → 5./6./7. (add as panels once signal quality is good)
8. last.

**Tradeoff:** items 1 + 2 are infrastructural and won't *look* like
progress on the dashboard; 3 / 5 / 6 / 7 are visible. If momentum
matters more than correctness, swap 3 earlier; if correctness matters
more, keep the order above.
