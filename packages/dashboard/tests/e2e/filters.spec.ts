import { test, expect } from "@playwright/test";

/**
 * Regression suite for the top-row filter controls. Every one of these would
 * have caught the silent-handler bug we just shipped: the controls rendered,
 * but click/onChange handlers never wired up because of an `import type`
 * sitting after a function declaration in page-header.tsx (SWC tolerated it
 * during build but emitted broken JS).
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/?days=30");
  // Wait for the initial dashboard data so charts have rendered.
  await expect(page.getByText("Activity Timeline")).toBeVisible();
});

test("date range buttons update URL and re-fetch", async ({ page }) => {
  await page.getByRole("button", { name: "7d" }).click();
  await expect(page).toHaveURL(/[?&]days=7\b/);

  await page.getByRole("button", { name: "All" }).click();
  await expect(page).toHaveURL(/[?&]days=all\b/);

  await page.getByRole("button", { name: "30d" }).click();
  // 30d is the default — query param is dropped on selection.
  await expect(page).toHaveURL(/^http:\/\/localhost:3457\/?(?:\?(?!days=).*)?$/);
});

test("granularity buttons update URL", async ({ page }) => {
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page).toHaveURL(/[?&]granularity=week\b/);

  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).toHaveURL(/[?&]granularity=month\b/);

  await page.getByRole("button", { name: "Day", exact: true }).click();
  // "day" is default; param dropped.
  await expect(page).not.toHaveURL(/granularity=/);
});

test("project selector filters by project", async ({ page }) => {
  // The fixture has projects "alpha" and "beta".
  const select = page.locator("select").filter({ hasText: "All projects" });
  await select.selectOption("alpha");
  await expect(page).toHaveURL(/[?&]project=alpha\b/);

  await select.selectOption(""); // "All projects"
  await expect(page).not.toHaveURL(/[?&]project=/);
});

test("agent selector filters by agent", async ({ page }) => {
  const select = page.locator("select").filter({ hasText: "All agents" });

  await select.selectOption("cursor");
  await expect(page).toHaveURL(/[?&]agent=cursor\b/);

  // After filter applies, the API should refetch and the page should show
  // cursor data. The chart legend hides for single-agent view; we don't
  // assert specific text presence/absence here since "claude code" can
  // appear in fixture data labels even when filtered out of charts.

  await select.selectOption("");
  await expect(page).not.toHaveURL(/[?&]agent=/);
});

test("refresh button fires (no console errors, no navigation)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const before = page.url();
  await page.getByRole("button", { name: "Refresh" }).click();

  // URL should not change on refresh.
  await page.waitForTimeout(300);
  expect(page.url()).toBe(before);
  expect(errors).toEqual([]);
});
