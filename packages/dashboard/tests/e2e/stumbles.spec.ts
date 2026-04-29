import { test, expect } from "@playwright/test";

/**
 * Stumbles leaderboard. Each row is one session where the agent ran the
 * same normalized tool call ≥3 times — db-mcp poking, MCP query spam,
 * repeated greps. Drillable into the session trace.
 */

test("stumbles API returns per-session repeated invocations", async ({ request }) => {
  const r = await request.get("/api/stumbles?days=30&limit=20");
  expect(r.ok()).toBe(true);
  const stumbles = (await r.json()) as Array<{
    sessionId: string;
    toolName: string;
    shape: string;
    occurrences: number;
    tokens: number;
  }>;
  expect(stumbles.length).toBeGreaterThan(0);

  for (const i of stumbles) {
    expect(i.occurrences).toBeGreaterThanOrEqual(3);
    expect(i.sessionId).toBeTruthy();
    expect(i.toolName).toBeTruthy();
    expect(i.shape.length).toBeGreaterThan(0);
  }
});

test("stumbles API tool='*mcp' filters out non-MCP rows", async ({ request }) => {
  const r = await request.get("/api/stumbles?days=30&tool=*mcp&limit=20");
  expect(r.ok()).toBe(true);
  const stumbles = (await r.json()) as Array<{ toolName: string }>;
  for (const i of stumbles) {
    expect(i.toolName.startsWith("mcp:") || i.toolName.startsWith("mcp__")).toBe(true);
  }
});

test("stumbles page shows the leaderboard", async ({ page }) => {
  await page.goto("/stumbles?days=30");
  await expect(page.getByRole("heading", { name: /stumbles/i }).first()).toBeVisible();

  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
});

test("stumbles page tool=*mcp filter narrows to MCP rows", async ({ page }) => {
  await page.goto("/stumbles?days=30&tool=*mcp");
  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
  // Tool column is the 3rd <td> (Session, Agent, Tool, Invocation, ...).
  const toolCells = page.locator("table tbody tr td:nth-child(3)");
  const count = await toolCells.count();
  for (let i = 0; i < count; i++) {
    const text = (await toolCells.nth(i).textContent())?.trim() ?? "";
    expect(text.startsWith("mcp:") || text.startsWith("mcp__")).toBe(true);
  }
});

test("top nav highlights the active page with brand orange", async ({ page }) => {
  await page.goto("/stumbles?days=30");
  const stumblesLink = page.getByRole("link", { name: "Stumbles" });
  // Active link gets the brand-color underline + text. Tailwind compiles
  // text-brand to color: var(--color-brand) which resolves to #EF8626.
  await expect(stumblesLink).toBeVisible();
  const color = await stumblesLink.evaluate((el) => getComputedStyle(el).color);
  // RGB equivalent of #EF8626.
  expect(color.replace(/\s+/g, "")).toBe("rgb(239,134,38)");
});
