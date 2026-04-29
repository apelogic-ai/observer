import { test, expect } from "@playwright/test";

/**
 * Dark spend leaderboard. Ranks sessions by tokens / max(LoC, 1) so
 * the worst per-line-shipped sessions float to the top — flail (zero
 * commits) and inefficient grinding (huge tokens for tiny diffs)
 * share the same column.
 */

test("dark-spend API only includes sessions with LoC > 0, sorted by tokens/LoC", async ({ request }) => {
  const r = await request.get("/api/dark-spend?days=30&limit=50");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as Array<{
    sessionId: string;
    commits: number;
    locDelta: number;
    tokens: number;
    tokensPerLoc: number;
  }>;
  // Every row must have shipped some code.
  for (const r of rows) expect(r.locDelta).toBeGreaterThan(0);
  // Ranking is monotonic descending in tokensPerLoc.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1]!.tokensPerLoc).toBeGreaterThanOrEqual(rows[i]!.tokensPerLoc);
  }
});

test("zero-code API only includes sessions with LoC = 0, sorted by tokens", async ({ request }) => {
  const r = await request.get("/api/zero-code?days=30&limit=50");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as Array<{ locDelta: number; tokens: number }>;
  for (const r of rows) expect(r.locDelta).toBe(0);
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i - 1]!.tokens).toBeGreaterThanOrEqual(rows[i]!.tokens);
  }
});

test("dark-spend page renders the leaderboard", async ({ page }) => {
  await page.goto("/dark-spend?days=30");
  await expect(page.getByRole("heading", { name: /dark spend/i }).first()).toBeVisible();
  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
});

test("zero-code page renders the leaderboard", async ({ page }) => {
  await page.goto("/zero-code?days=30");
  await expect(page.getByRole("heading", { name: /zero code/i }).first()).toBeVisible();
  // Fixture has at least one zero-LoC session (claude-beta-1 has tool calls
  // but no committed code linked to it).
  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
});
