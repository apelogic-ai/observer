import { test, expect } from "@playwright/test";

/**
 * Per-session redundant-loop detector. Each row is one concrete
 * incident — "session X, agent ran <thing> N times" — drillable into
 * the session trace. Generic across tools: db-mcp poking, git status
 * spam, repeated reads of the same file all surface here.
 */

test("incidents API returns per-session repeated invocations", async ({ request }) => {
  const r = await request.get("/api/incidents?days=30&limit=20");
  expect(r.ok()).toBe(true);
  const incidents = (await r.json()) as Array<{
    sessionId: string;
    toolName: string;
    shape: string;
    occurrences: number;
    tokens: number;
  }>;
  expect(incidents.length).toBeGreaterThan(0);

  // Threshold is ≥3 — every incident must clear it.
  for (const i of incidents) {
    expect(i.occurrences).toBeGreaterThanOrEqual(3);
    expect(i.sessionId).toBeTruthy();
    expect(i.toolName).toBeTruthy();
    expect(i.shape.length).toBeGreaterThan(0);
  }
});

test("incidents API tool='*mcp' filters out non-MCP rows", async ({ request }) => {
  const r = await request.get("/api/incidents?days=30&tool=*mcp&limit=20");
  expect(r.ok()).toBe(true);
  const incidents = (await r.json()) as Array<{ toolName: string }>;
  // Empty is acceptable (fixture may not have ≥3 MCP repetitions); but every
  // row that does appear must be an MCP tool.
  for (const i of incidents) {
    expect(i.toolName.startsWith("mcp:") || i.toolName.startsWith("mcp__")).toBe(true);
  }
});

test("incidents page shows the leaderboard with sessions and shapes", async ({ page }) => {
  await page.goto("/incidents?days=30");
  await expect(page.getByText(/redundant.*loop|repeated.*loop|incident/i).first()).toBeVisible();

  // At least one row in the table.
  const rows = page.locator("table tbody tr");
  await expect.poll(async () => rows.count(), { timeout: 5000 }).toBeGreaterThan(0);
});

test("incidents page tool=*mcp filter narrows to MCP rows", async ({ page }) => {
  await page.goto("/incidents?days=30&tool=*mcp");
  // Wait for table to render.
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
