# Agent rules

Mandatory workflow rules for any change to this repository. These
override convenience and personal preference. If a rule is wrong,
amend it via PR — don't bypass it.

## 1. Branch → PR → review → merge → release

No direct pushes to `master`. Every change, no matter how small:

1. Create a feature branch (`feat/<slug>`, `fix/<slug>`, `chore/<slug>`).
2. Push the branch.
3. Open a pull request against `master`.
4. CI gates (lint, typecheck, unit tests, e2e) must be green.
5. Merge to `master`.
6. Releases are cut from `master` via `bun scripts/release.ts <version>`,
   which tags `v<version>` and triggers the Release workflow.

The only thing that lands on `master` directly is a merge commit from
a PR.

## 2. Strict TDD

For any production code change:

1. **Red** — write the failing test first. Run it. See it fail. The
   failure message must be specific to the behavior under test, not a
   compile error or a missing import.
2. **Green** — write the minimum code that makes the test pass. No
   extra features, no speculative abstractions.
3. **Refactor** — clean up without changing observable behavior. The
   test stays green throughout.

Bug fixes start with a failing regression test that reproduces the bug.

Narrow exceptions: type-only changes, build glue, CI workflows, pure
docs, throwaway diagnostics removed in the same PR.

## 3. How the agent applies this

- Never push to `master`. If asked to "push", check out a branch first.
- Never write a function before the test that calls it.
- If a rule conflicts with a user instruction, ask before bypassing.

---

Package-specific rules live alongside each package (e.g.
`packages/dashboard/AGENTS.md` for the Next.js-specific notes).
