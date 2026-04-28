import { test, expect } from "@playwright/test";

/**
 * Tests for the session ↔ commit linkage UI: sibling-commit list on the
 * commit page, Session column in the recent-commits table, "By session"
 * toggle on the Overview, and the session-detail token/active/activity/LoC
 * widgets. These cover behavior introduced when reframing the commit page
 * away from misleading "Agent Session" totals toward a session-as-parent
 * model.
 */

test("commits table shows linked session column with hash → /session", async ({ page }) => {
  await page.goto("/?days=30");
  // Wait for git data to load.
  await expect(page.getByText("Recent Commits")).toBeVisible();

  // deadbeef is fixture's session-linked commit (sessionId=claude-alpha-1).
  // The session column shows the first 8 chars of the id, linked to /session.
  const row = page.locator("tr", { has: page.getByText("deadbeef") });
  const sessionLink = row.locator("a[href*='/session'][href*='id=']");
  await expect(sessionLink).toBeVisible();
  await expect(sessionLink).toHaveText(/^claude-a/);
});

test("human commit shows '—' in session column", async ({ page }) => {
  await page.goto("/?days=30");
  await expect(page.getByText("Recent Commits")).toBeVisible();

  // feedface is the unlinked human commit fixture.
  const row = page.locator("tr", { has: page.getByText("feedface") });
  // No session link inside the row.
  await expect(row.locator("a[href*='/session'][href*='id=']")).toHaveCount(0);
  // The em-dash placeholder is present.
  await expect(row.getByText("—")).toBeVisible();
});

test("commit page shows sibling commits from the same session", async ({ page }) => {
  await page.goto("/commit/?sha=deadbeef");
  // The "Session containing this commit" card is the last to render —
  // wait for it instead of relying on networkidle which races the
  // session-summary fetch.
  await expect(page.getByText("Session containing this commit")).toBeVisible({ timeout: 10_000 });

  // The siblings list header (count is rendered in the same line).
  await expect(page.getByText(/Commits from this session \(\d+\)/i)).toBeVisible();
  // Both fixture commits with sessionId=claude-alpha-1 should appear in
  // the siblings list — use .first() because the current commit's title
  // also appears at the top of the page.
  await expect(page.getByText("feat: agent-authored sibling A").first()).toBeVisible();
  await expect(page.getByText(/sibling B/).first()).toBeVisible();
});

test("By-session toggle on overview swaps the commits table for the sessions list", async ({ page }) => {
  await page.goto("/?days=30");
  // Default view: by commit. The flat commits-table is visible.
  await expect(page.getByText("Recent Commits")).toBeVisible();

  await page.getByRole("button", { name: "By session" }).click();

  // Sessions header replaces "Recent Commits".
  await expect(page.getByText(/^Sessions \(\d+\)$/)).toBeVisible();
  // The fixture's session that produced commits should appear in the list,
  // showing its commit count and a tok/LoC ratio.
  await expect(page.getByText(/\d+ commits?/).first()).toBeVisible();
  await expect(page.getByText(/tok\/LoC/).first()).toBeVisible();

  await page.getByRole("button", { name: "By commit" }).click();
  await expect(page.getByText("Recent Commits")).toBeVisible();
});

test("session detail page shows tokens, active duration, activity sparkline, LoC, tokens/LoC", async ({ page }) => {
  // trailingSlash: true in next.config — bare /session?id=... 308-redirects
  // to /session/?id=... and the redirect can race the test's first probe.
  // Hit the canonical URL directly.
  await page.goto("/session/?id=claude-alpha-1");
  // Wait for the trace-timeline to render — that's the last block on the
  // page, so by then all the cards above have rendered too.
  await expect(page.getByText("Trace Timeline")).toBeVisible();

  // Token totals card (4 cells). Labels live in source as title-case
  // and are uppercased via CSS — getByText matches source, not display.
  await expect(page.getByText("Input", { exact: true })).toBeVisible();
  await expect(page.getByText("Output", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache Read", { exact: true })).toBeVisible();
  await expect(page.getByText("Cache Write", { exact: true })).toBeVisible();

  // Active duration appears alongside wall time. The fixture session has a
  // single timestamp range, so active is 0/<1m — we just assert the
  // word "active" appears next to the duration.
  await expect(page.getByText(/wall/)).toBeVisible();
  await expect(page.getByText(/active/).first()).toBeVisible();

  // Activity sparkline label (rendered uppercase via Tailwind, so match
  // case-insensitively to avoid being brittle to the CSS choice).
  await expect(page.getByText(/Activity \(entries per bucket\)/i)).toBeVisible();

  // LoC + tokens/LoC card (only renders when commits exist; deadbeef +
  // cafebabe are linked to claude-alpha-1). Source text is title-case,
  // CSS uppercases it.
  await expect(page.getByText("Lines Added", { exact: true })).toBeVisible();
  await expect(page.getByText("Lines Deleted", { exact: true })).toBeVisible();
  await expect(page.getByText("Net LoC Changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Tokens / LoC", { exact: true })).toBeVisible();
});
