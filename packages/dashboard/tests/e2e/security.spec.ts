import { test, expect } from "@playwright/test";

/**
 * Leaks page — surfaces redaction markers (`[REDACTED:<type>]`) that
 * the agent's scanner left in trace data. No actual secret values
 * reach the dashboard; the count is the marker count, attributed to
 * the session/agent/project the marker appeared in.
 */

test("security findings API returns aggregated patterns", async ({ request }) => {
  const r = await request.get("/api/security/findings?days=30&limit=20");
  expect(r.ok()).toBe(true);
  const findings = (await r.json()) as Array<{
    patternType: string;
    count: number;
    sessions: number;
    projects: number;
    agents: string[];
  }>;
  expect(findings.length).toBeGreaterThan(0);
  // Seeded fixture has at least aws_access_key and github_token markers.
  expect(findings.some((f) => f.patternType === "aws_access_key")).toBe(true);
  expect(findings.some((f) => f.patternType === "github_token")).toBe(true);

  for (const f of findings) {
    expect(f.count).toBeGreaterThan(0);
    expect(f.sessions).toBeGreaterThan(0);
    expect(f.projects).toBeGreaterThan(0);
    expect(f.agents.length).toBeGreaterThan(0);
  }
});

test("security timeline API returns per-(date, pattern) rows for stacking", async ({ request }) => {
  const r = await request.get("/api/security/timeline?days=30");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as Array<{ date: string; patternType: string; count: number }>;
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.count).toBeGreaterThan(0);
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.patternType).toBeTruthy();
  }
  // Multiple patterns means at least two distinct patternType values
  // surface in the seeded fixture.
  const patterns = new Set(rows.map((r) => r.patternType));
  expect(patterns.size).toBeGreaterThanOrEqual(2);
});

test("date param scopes findings/sessions to a single calendar day", async ({ request }) => {
  // The leaks page uses ?date=YYYY-MM-DD to drill into one bar's
  // findings. Server must honor it on findings + sessions endpoints.
  const empty = await request.get("/api/security/findings?date=2020-01-01");
  expect(empty.ok()).toBe(true);
  expect(await empty.json()).toEqual([]);
});

test("security page renders the leaderboard + timeline", async ({ page }) => {
  await page.goto("/security?days=30");
  await expect(page.getByRole("heading", { name: /leaks/i }).first()).toBeVisible();
  // Leaderboard table shows up
  await expect(page.locator("table").filter({ hasText: "aws_access_key" }).first()).toBeVisible();
  await expect(page.locator("table").filter({ hasText: "github_token" }).first()).toBeVisible();
});

test("top nav shows Leaks link", async ({ page }) => {
  await page.goto("/security?days=30");
  const link = page.getByRole("link", { name: "Leaks" });
  await expect(link).toBeVisible();
});

test("?date=… renders the day banner with a Clear button", async ({ page }) => {
  // Direct-navigating with the URL param is the same code path the
  // chart click triggers — verifies the banner UI without depending on
  // SVG hit-testing the recharts bar.
  await page.goto("/security?days=30&date=2026-04-01");
  await expect(page.getByText(/showing findings for/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /clear day/i })).toBeVisible();
  await page.getByRole("button", { name: /clear day/i }).click();
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/security[^?]*\?(?!.*\bdate=)/);
});
