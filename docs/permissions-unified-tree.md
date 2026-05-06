# Permissions UI: Unified Tree + Write-Back (Future Redesign)

Captured 2026-05-06 during the auto-load feature work, while the
implementation was still in three sections (categories table, merge
card, settings.json output). This doc is a deliberate save-the-thread
for the bigger redesign so we don't lose the framing when we come
back to it.

## Where we are today

`/permissions` shows three vertically-stacked sections:

1. **What the agent actually used** — frequency-ranked rows grouped
   by category (core / build / file / mcp / other), with hierarchical
   accordions for Bash verbs and a checkbox per row.
2. **Merge with existing settings.json** — auto-loaded textarea, diff
   panel (added / subsumed), suggested broadenings.
3. **settings.json output** — the resulting merged JSON, with a Copy
   button. The user pastes it into their settings file by hand.

This works, but the UX has artifacts of how the feature grew:

- The user has to think in three frames simultaneously: "what was used",
  "what I have today", "what I'd ship". The same entries appear in
  multiple places under different headings.
- "Already in your settings" isn't surfaced at the row level — you
  only see the existing list as raw JSON in the textarea, and the
  diff is summarized in two columns at the bottom.
- The handoff is still copy-paste. We auto-load *from* disk but
  require a manual paste *to* disk. Asymmetric and easy to forget.

## The proposed model

A single tree view, rooted on the user's settings, with our suggestions
overlaid. Each leaf is one allowlist entry. Each row colored by source.
A SAVE button writes back to a chosen target file.

```
[ ] Bash
    [✓] Bash(git:*)                                       (32 calls)
        [orange] Bash(git status:*)   already in settings    (12)
        [blue]   Bash(git diff:*)     would broaden          (5)
    [✓] Bash(curl -sL "https://...")  already in settings    (3)
[ ] WebFetch
    [orange] WebFetch(domain:github.com)   already         (—)
    [blue]   WebFetch(domain:anthropic.com) suggested      (—)
[ ] Read                                already           (104)
[ ] mcp:db:shell                        suggested          (47)
```

Colors:
- **orange** — entry is in one of the user's existing settings files
  (badge says which: user-global / project-shared / project-local).
- **blue** — entry would be added by Observer's suggestion based on
  observed agent calls.
- **gray-strikethrough** — existing entry that a checked broader
  wildcard would subsume (i.e. would be removed if you SAVE).

Frequency stays first-class as a column — losing it would weaken the
"ground truth, not guesses" framing that justifies the page existing
in the first place.

## The hard part: writing back

The tree visualization is a refactor; the SAVE button is a feature.
Three real decisions:

### 1. Which file to write to

Three candidates per project:

| Target           | Path                                            | Scope                |
|------------------|-------------------------------------------------|----------------------|
| user-global      | `~/.claude/settings.json`                       | every Claude session |
| project-shared   | `<repoLocal>/.claude/settings.json`             | committed to repo    |
| project-local    | `<repoLocal>/.claude/settings.local.json`       | this developer only  |

Defaults the picker to **project-local** — that's where ad-hoc tweaks
belong, it's git-ignored by default in most repos, and it limits blast
radius. User can override per write.

If we wanted to be slick, we'd let the user *split* the diff: "write
the verb wildcards to project-shared so the team gets them, write
exact paths to project-local so they don't pollute teammates' config."
That's a stretch goal — needs a more elaborate diff dialog.

### 2. Preserving unrelated keys

Settings files have far more than `permissions.allow`:

```jsonc
{
  "permissions": {
    "allow": [...],
    "deny": [...],
    "ask": [...],
    "defaultMode": "acceptEdits"
  },
  "hooks": {...},
  "mcp": {...},
  "model": "..."
}
```

We must surgically edit only the `allow` array. Two approaches:

- **Pure JSON** — `JSON.parse` → mutate `.permissions.allow` →
  `JSON.stringify` → write. Loses comments, reorders keys, reformats
  whitespace. Not faithful for a config the user authored.
- **JSONC-aware edit** — use a CST-preserving editor (e.g.
  `jsonc-parser` `applyEdits`) that mutates just the array contents,
  leaving every other byte intact.

Go with **JSONC-aware**. The user wrote that file; we round-trip it
faithfully. Preserves comments (Claude Code accepts JSONC).

### 3. Safety

Hard requirements before flipping a bit on disk:

- **Backup**: write `<file>.backup-<ISO timestamp>` next to the
  original before overwriting. Keep the last N (~5).
- **Diff preview**: confirmation dialog shows the unified diff
  (entries added / removed) and the target path. No silent writes.
- **Atomic write**: write to `<file>.tmp` then rename. Avoids a
  partial-write nuking the file on crash mid-write.
- **Validate target file is writable** up front; surface "permission
  denied" before the user clicks SAVE.

## Implementation sketch

Three pieces, in order:

1. **Parse-and-render layer** (mostly client-side TypeScript):
   - Take `fetchedExisting.allow` + `rows` (suggestions) → unified
     `TreeNode[]` with per-leaf source: `existing | suggested | both`.
   - Subsumption resolves at tree-build time (suggested verb wildcard
     subsumes existing narrow entries → mark them strikethrough).
   - Render flat (today) or tree (future) — same data structure.

2. **Server SAVE endpoint**:
   - `POST /api/permissions/write` `{ target: "project-local" | ..., entries: string[] }`
   - Resolves target path via the same `repoLocal` lookup that
     `getExistingSettings` uses.
   - JSONC edit; backup; atomic rename.
   - Returns the new file's content for the UI to display "saved".

3. **Confirm dialog**:
   - Pre-write diff (added / removed / unchanged).
   - Target file picker (defaults to project-local).
   - Cancel / Confirm.

## Out of scope (for the first cut)

- **Splitting** the diff across multiple target files in one save.
- **Editing `deny` / `ask` / `defaultMode`** — only `allow`.
- **Merging back observer-suggested broadenings into project-shared**
  via a PR. Tempting but separates concerns: that's a code-mod, not
  a config-edit.

## Sequencing

The color-coding pass (orange checkbox = already in settings, blue =
suggestion-only) is a stepping stone. It validates the visual model
of "tree overlay" cheaply, before we commit to the bigger refactor +
write-back. If the color-coding feels right at the row level, the
tree-with-SAVE is the natural next step. If it doesn't, we learn that
without having paid for the refactor.
