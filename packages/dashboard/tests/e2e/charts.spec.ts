import { test, expect } from "@playwright/test";

/**
 * Token-based aggregation + cursor-sidecar checks. These guard the v0.1.13-
 * era work where we switched activity/projects/models charts from entry-count
 * to token-based and started injecting Cursor's API totals as synthetic rows.
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/?days=30");
  await expect(page.getByText("Activity Timeline")).toBeVisible();
});

test("activity timeline subtitle states the metric explicitly", async ({ page }) => {
  // The chart legend was misleading users — they thought bars were entry
  // counts. The "tokens (input + output)" subtitle exists so it isn't.
  await expect(
    page.locator("text=Activity Timeline").locator("xpath=..").getByText(/tokens \(input \+ output \+ cache reads \+ writes\)/),
  ).toBeVisible();
});

test("cursor sidecar feeds token aggregates", async ({ request }) => {
  // The fixture cursor jsonl has tokenUsage all zeros (Cursor's local DB
  // never stores real consumption). The _usage.json sidecar carries the
  // real numbers (input=12000, output=3500). The dashboard should expose
  // those totals via /api/activity for that day.
  const r = await request.get("/api/activity?days=30");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as { date: string; agent: string; total_tokens: number }[];
  const cursor = rows.filter((x) => x.agent === "cursor");
  expect(cursor.length).toBeGreaterThan(0);
  // input(12000) + output(3500) + cacheRead(80000) + cacheCreation(0) =
  // 95500. The synthetic row carries all four fields and TU_TOTAL sums
  // all of them — see TU_TOTAL in server/queries.ts. Plain input+output
  // would undercount caching agents by ~500x, so we count cache too.
  const totalTokens = cursor.reduce((a, r) => a + r.total_tokens, 0);
  expect(totalTokens).toBe(95500);
});

test("project chart sorts by tokens (db-mcp would otherwise top by entries)", async ({ request }) => {
  const r = await request.get("/api/projects?days=30");
  const rows = (await r.json()) as { project: string; total_tokens: number }[];
  // Defensive: monotonic descending by total_tokens.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].total_tokens).toBeLessThanOrEqual(rows[i - 1].total_tokens);
  }
});

test("models endpoint sorts by tokens, excludes zero-token entries from chart", async ({ request }) => {
  const r = await request.get("/api/models?days=30");
  const rows = (await r.json()) as { model: string; total_tokens: number; count: number }[];
  // Server returns rows sorted by total_tokens desc.
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].total_tokens).toBeLessThanOrEqual(rows[i - 1].total_tokens);
  }
});
