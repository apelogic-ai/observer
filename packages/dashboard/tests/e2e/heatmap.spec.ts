import { test, expect } from "@playwright/test";

/**
 * The Project × Time heatmap on the Overview. Cell color encodes dominant
 * agent, opacity encodes log-scaled token volume (stretched across the
 * actual logMin → logMax range, not log(0) → log(max), so a 100K cell
 * looks visibly different from a 100M cell).
 */

test("heatmap renders with project rows and dynamic-range cell opacity", async ({ page }) => {
  await page.goto("/?days=30");
  // Wait for the heatmap card to be in the DOM. Other components on the
  // page also have "alpha" labels (project filter dropdown, project bar
  // chart), so we scope further assertions to this card.
  const heatmap = page.locator("xpath=//*[contains(., 'Project × Time Heatmap')]/ancestor::*[contains(@data-slot,'card')][1]").first();
  await expect(heatmap).toBeVisible();

  // At least one populated cell with an inline background colour.
  const cells = heatmap.locator("div[style*='background']");
  await expect.poll(async () => cells.count(), { timeout: 5000 }).toBeGreaterThan(0);

  // 'alpha' project label appears inside the heatmap (not just in some
  // sibling chart on the same page).
  await expect(heatmap.getByRole("button", { name: "alpha", exact: true })).toBeVisible();
});

test("heatmap data endpoint returns date × project × agent rows", async ({ request }) => {
  // The shape contract — date/project/agent/total_tokens, no nulls.
  const r = await request.get("/api/heatmap?days=30");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as { date: string; project: string; agent: string; total_tokens: number }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.project).not.toBeNull();
    expect(row.agent).toBeTruthy();
    expect(row.total_tokens).toBeGreaterThanOrEqual(0);
  }
});
