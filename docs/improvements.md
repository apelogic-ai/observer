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

**Boundary.** Don't conflate this with the validation panel or any
new productivity card. One PR per behaviour change.

## 2. Tool-result instrumentation: exitCode, durationMs, success

**Finding.** Half the planned downstream work (error loops, slow tests,
validation outcomes) needs a reliable success/failure signal per tool
call. Today we have:
- **Codex** — `shell` results carry `exit_code` in the raw payload, but
  the parser doesn't surface it on normalized rows.
- **Claude Code** — `tool_result` has `is_error: bool`; we capture it,
  but no exit code, no duration. "Success" today is a fragile string
  search for `error|failed|exception` in result text.

**Scope:**
1. Extend the trace schema with `exitCode: number | null`,
   `durationMs: number | null`, `success: boolean | null`.
2. Update `packages/agent/src/parsers/{claude,codex}.ts` to emit those
   fields from the available raw shapes.
3. Re-scan to backfill historical data.
4. Replace the substring-error heuristic in `getStumbles` /
   dark-spend / leaks with the typed fields where available; keep the
   substring fallback only for Claude Code where there's no exit code.

**Asymmetry.** Codex gets `exitCode`; Claude Code only gets `success`
derived from `is_error`. That's fine — surface both, document the
limitation, don't paper over it.

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

## 4. Validation-loop detector ("stuck agent" signal)

Several sessions ran 200–456 validation commands. That's a different
shape from generic stumbles: same test fails → same edit → same test.

Add a detector for `T → E → T → E → T` cycles where T is a
validation-tool call with the same arguments and E is an edit to the
same file. Rank by tokens and active minutes.

Depends on **#2** for clean signal (need to know which T calls
actually failed).

## 5. User intervention rate (autonomy score)

Sessions with extreme user-message counts (375 / 240 / 149 / 134 / 113
turns) are useful proxies for "agent needed too much steering."

Surface:
- user turns per commit
- user turns per LoC delta
- tool calls per user turn

Pure SQL on existing data — no new instrumentation needed.

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
