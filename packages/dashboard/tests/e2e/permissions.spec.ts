import { test, expect } from "@playwright/test";

/**
 * Permissions page — frequency-ranked tool usage with a copyable
 * Claude Code settings.json snippet. Tests the API + page render +
 * the redundancy dedup (verb-level entries subsume subcommand-level).
 */

test("permissions API returns categorized rows", async ({ request }) => {
  const r = await request.get("/api/permissions?days=30");
  expect(r.ok()).toBe(true);
  const rows = (await r.json()) as Array<{
    category: string;
    tool: string;
    path: string[];
    count: number;
    sessions: number;
    allowlistEntry: string;
  }>;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(["core", "build", "file", "mcp", "other"]).toContain(r.category);
    expect(r.allowlistEntry).toBeTruthy();
  }
  // Seeded fixture has at least Bash + Read + an MCP tool.
  expect(rows.some((r) => r.category === "core")).toBe(true);
});

test("permissions page renders with category sections", async ({ page }) => {
  await page.goto("/permissions?days=30");
  await expect(page.getByRole("heading", { name: /permissions/i }).first()).toBeVisible();
  // settings.json card present
  await expect(page.locator("pre").filter({ hasText: /"permissions"/ })).toBeVisible();
});

test("top nav shows Permissions link", async ({ page }) => {
  await page.goto("/permissions?days=30");
  await expect(page.getByRole("link", { name: "Permissions" })).toBeVisible();
});

test("changing the date filter resets pasted JSON and the merged-output mode", async ({ page }) => {
  await page.goto("/permissions?days=30");
  // Paste an existing settings.json so the page enters "merged" mode.
  await page.locator("textarea").fill(
    JSON.stringify({ permissions: { allow: ["WebFetch(domain:github.com)"] } }),
  );
  await expect(page.getByText(/settings\.json\s*\(merged\)/i)).toBeVisible();

  // Change the date filter — different scope, different command tree.
  // Anything the user pasted/toggled belongs to the previous scope and
  // would silently corrupt the new view if it persisted.
  await page.getByRole("button", { name: "7d" }).click();
  await expect(page).toHaveURL(/[?&]days=7\b/);

  await expect(page.locator("textarea")).toHaveValue("");
  await expect(page.getByText(/settings\.json\s*\(merged\)/i)).not.toBeVisible();
});

test("verb rows are accordions: collapsed by default when the verb is checked", async ({ page }) => {
  await page.goto("/permissions?days=30");
  // Bash(grep:*) is auto-checked by the verb-granularity default — its
  // child rows (Bash(grep -r:*), Bash(grep -i:*)) are covered, so
  // they should be hidden until the user opens the accordion.
  const grepCode = page.locator("code", { hasText: /^Bash\(grep:\*\)$/ }).first();
  await expect(grepCode).toBeVisible();
  await expect(page.locator("code", { hasText: /^Bash\(grep \S.*:\*\)$/ })).toHaveCount(0);

  // Click the expand button on the grep row — children become visible.
  const grepRow = page.locator("tr").filter({ has: grepCode });
  await grepRow.getByRole("button").click();
  await expect(page.locator("code", { hasText: /^Bash\(grep \S.*:\*\)$/ }).first()).toBeVisible();

  // Toggling again collapses.
  await grepRow.getByRole("button").click();
  await expect(page.locator("code", { hasText: /^Bash\(grep \S.*:\*\)$/ })).toHaveCount(0);
});

test("merge card suggests verb wildcards for verbs with multiple entries in pasted JSON", async ({ page }) => {
  await page.goto("/permissions?days=30");
  await page.locator("textarea").fill(
    JSON.stringify({
      permissions: {
        allow: [
          "Bash(sqlite3 db1.sqlite 'SELECT * FROM x')",
          "Bash(sqlite3 db2.sqlite 'SELECT * FROM y')",
          "Bash(sqlite3 db3.sqlite 'SELECT count(*) FROM z')",
          "Bash(awk -F: '{print $1}')",  // single — should NOT suggest
        ],
      },
    }),
  );

  // Suggestion appears with the broadenable verb and a count hint.
  await expect(page.getByText(/suggested broadening/i)).toBeVisible();
  await expect(page.locator("code", { hasText: /^Bash\(sqlite3:\*\)$/ })).toBeVisible();
  // No suggestion for the single-entry verb.
  await expect(page.locator("code", { hasText: /^Bash\(awk:\*\)$/ })).toHaveCount(0);

  // The suggestion is unchecked by default — the merged output keeps
  // the original sqlite3 entries verbatim.
  const pre = page.locator("pre").filter({ hasText: /"permissions"/ });
  await expect(pre).toContainText("sqlite3 db1.sqlite");

  // Checking the suggestion subsumes the verbose entries.
  const suggestionRow = page.locator("label").filter({ has: page.locator("code", { hasText: /^Bash\(sqlite3:\*\)$/ }) });
  await suggestionRow.locator("input[type=checkbox]").check();
  await expect(pre).toContainText("Bash(sqlite3:*)");
  await expect(pre).not.toContainText("sqlite3 db1.sqlite");
});

test("merge textarea unions existing settings.json with the candidate", async ({ page }) => {
  await page.goto("/permissions?days=30");
  // The merge card mounted.
  await expect(page.getByText(/merge with existing settings\.json/i)).toBeVisible();

  // Paste an existing settings.json that includes an opaque WebFetch
  // entry (Observer can't generate this) and a redundant Bash entry.
  const existing = JSON.stringify({
    permissions: {
      allow: ["WebFetch(domain:github.com)", "Bash(git status:*)"],
    },
  });
  await page.locator("textarea").fill(existing);

  // The settings.json card title flips to "(merged)".
  await expect(page.getByText(/settings\.json\s*\(merged\)/i)).toBeVisible();

  // The merged output preserves the WebFetch entry.
  const pre = page.locator("pre").filter({ hasText: /"permissions"/ });
  await expect(pre).toContainText("WebFetch(domain:github.com)");
});
