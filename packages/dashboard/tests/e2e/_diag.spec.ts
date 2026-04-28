import { test } from "@playwright/test";

/**
 * Runs first (alphabetical via leading underscore) so its output appears
 * before any failures. Dumps the dashboard server's view of the world so
 * we can tell, in CI logs, whether the fixture is actually being read.
 *
 * Delete this once the e2e setup is reliable in CI — it's just a probe.
 */

test("diag: server state at start of suite", async ({ request }) => {
  const diag = await request.get("/api/diag");
  const stats = await request.get("/api/stats?days=30");
  const projects = await request.get("/api/project-list");
  const activity = await request.get("/api/activity?days=30");
  const heatmap = await request.get("/api/heatmap?days=30");

  console.log("\n=== SERVER DIAG ===");
  console.log("/api/diag:    ", await diag.text());
  console.log("/api/stats:   ", await stats.text());
  console.log("/api/project-list:", await projects.text());
  console.log("/api/activity (count): ", ((await activity.json()) as unknown[]).length);
  console.log("/api/heatmap (count):  ", ((await heatmap.json()) as unknown[]).length);
  console.log("=== END DIAG ===\n");
});
