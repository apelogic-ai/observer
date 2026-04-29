import { test, expect } from "@playwright/test";

/**
 * Dark spend leaderboard. Ranks sessions by tokens / max(LoC, 1) so
 * the worst per-line-shipped sessions float to the top — flail (zero
 * commits) and inefficient grinding (huge tokens for tiny diffs)
 * share the same column.
 */

test("dark-spend API ranks zero-commit sessions above efficient ones", async ({ request }) => {
  const r = await request.get("/api/dark-spend?days=30&limit=50");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as Array<{
    sessionId: string;
    commits: number;
    locDelta: number;
    tokens: number;
    tokensPerLoc: number;
  }>;
  expect(rows.length).toBeGreaterThan(0);

  // Ranking is monotonic descending in tokensPerLoc.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1]!.tokensPerLoc).toBeGreaterThanOrEqual(rows[i]!.tokensPerLoc);
  }
});

test("dark-spend page renders the leaderboard", async ({ page }) => {
  await page.goto("/dark-spend?days=30");
  await expect(page.getByText(/dark spend/i).first()).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
});
