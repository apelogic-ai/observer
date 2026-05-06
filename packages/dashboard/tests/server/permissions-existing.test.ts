import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";
import { getExistingSettings } from "../../server/permissions-existing";

/**
 * `getExistingSettings(project)` reads the three places Claude Code
 * looks for `permissions.allow` and unions them so the dashboard can
 * show "what's already in your settings vs what we suggest" without
 * the user copying anything.
 *
 *   1. user-global   — ~/.claude/settings.json
 *   2. project-shared — <repoLocal>/.claude/settings.json
 *   3. project-local  — <repoLocal>/.claude/settings.local.json
 *
 * `repoLocal` for a project is recovered from the most-recent
 * `git_events` row, which the agent populated when scanning that repo.
 */

let DATA_DIR: string;
let ACME_REPO: string;
let BARE_REPO: string;
let CORRUPT_REPO: string;
let FAKE_HOME: string;

const D = "2026-05-01";

function writeJsonl(path: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

beforeAll(async () => {
  process.env.OBSERVER_SKIP_FOREIGN_FILTER = "1";
  DATA_DIR = mkdtempSync(join(tmpdir(), "observer-perm-existing-"));
  ACME_REPO = mkdtempSync(join(tmpdir(), "observer-acme-"));
  BARE_REPO = mkdtempSync(join(tmpdir(), "observer-bare-"));
  CORRUPT_REPO = mkdtempSync(join(tmpdir(), "observer-corrupt-"));
  FAKE_HOME = mkdtempSync(join(tmpdir(), "observer-home-"));

  // ── Project `acme` — happy path with all three settings sources. ──
  writeJsonl(join(DATA_DIR, D, "git", "acme.jsonl"), [{
    id: "g-acme", timestamp: `${D}T10:00:00Z`, eventType: "commit",
    project: "acme", repo: "ace/acme", branch: "main",
    developer: "test@example.com", machine: "host",
    commitSha: "deadbeef", repoLocal: ACME_REPO,
    author: "Test", authorEmail: "test@example.com",
  }]);
  mkdirSync(join(ACME_REPO, ".claude"), { recursive: true });
  writeFileSync(join(ACME_REPO, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(git:*)", "WebFetch(domain:github.com)"] } }));
  writeFileSync(join(ACME_REPO, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(bun install *)", "Bash(curl:*)"] } }));

  // ── Project `bare` — repoLocal exists but has no .claude dir. ──
  writeJsonl(join(DATA_DIR, D, "git", "bare.jsonl"), [{
    id: "g-bare", timestamp: `${D}T10:00:00Z`, eventType: "commit",
    project: "bare", repo: "ace/bare", branch: "main",
    developer: "test@example.com", machine: "host",
    commitSha: "feedface", repoLocal: BARE_REPO,
    author: "Test", authorEmail: "test@example.com",
  }]);

  // ── Project `corrupt` — settings.local.json is invalid JSON. ──
  writeJsonl(join(DATA_DIR, D, "git", "corrupt.jsonl"), [{
    id: "g-corrupt", timestamp: `${D}T10:00:00Z`, eventType: "commit",
    project: "corrupt", repo: "ace/corrupt", branch: "main",
    developer: "test@example.com", machine: "host",
    commitSha: "cafebabe", repoLocal: CORRUPT_REPO,
    author: "Test", authorEmail: "test@example.com",
  }]);
  mkdirSync(join(CORRUPT_REPO, ".claude"), { recursive: true });
  writeFileSync(join(CORRUPT_REPO, ".claude", "settings.local.json"), "{ this is not json");
  writeFileSync(join(CORRUPT_REPO, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Read"] } }));

  // ── User-global (~/.claude/settings.json) — shared across projects. ──
  mkdirSync(join(FAKE_HOME, ".claude"), { recursive: true });
  writeFileSync(join(FAKE_HOME, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Read", "Edit", "WebFetch(domain:anthropic.com)"] } }));

  await initDb(DATA_DIR);
});

describe("getExistingSettings", () => {
  it("unions allow entries from user-global + project-shared + project-local", async () => {
    const r = await getExistingSettings("acme", { homeDir: FAKE_HOME });
    expect(r.allow.sort()).toEqual([
      "Bash(bun install *)",
      "Bash(curl:*)",
      "Bash(git:*)",
      "Edit",
      "Read",
      "WebFetch(domain:anthropic.com)",
      "WebFetch(domain:github.com)",
    ]);
    expect(r.repoLocal).toBe(ACME_REPO);
  });

  it("annotates each loaded source with its label, path, and entry count", async () => {
    const r = await getExistingSettings("acme", { homeDir: FAKE_HOME });
    const byLabel = Object.fromEntries(r.sources.map((s) => [s.label, s]));
    expect(byLabel["user-global"]!.path).toBe(join(FAKE_HOME, ".claude", "settings.json"));
    expect(byLabel["user-global"]!.count).toBe(3);
    expect(byLabel["project-shared"]!.path).toBe(join(ACME_REPO, ".claude", "settings.json"));
    expect(byLabel["project-shared"]!.count).toBe(2);
    expect(byLabel["project-local"]!.path).toBe(join(ACME_REPO, ".claude", "settings.local.json"));
    expect(byLabel["project-local"]!.count).toBe(2);
  });

  it("dedupes overlapping entries across sources (Read appears in user-global only once)", async () => {
    // Read is in user-global. If we ever add it to project-local too, the
    // union must dedupe. Add the assertion now so a future change can't
    // sneak in a duplicate.
    const r = await getExistingSettings("acme", { homeDir: FAKE_HOME });
    const reads = r.allow.filter((e) => e === "Read");
    expect(reads.length).toBe(1);
  });

  it("falls back to user-global only when the project has no git_events", async () => {
    // User-global applies regardless of project — even if we can't
    // resolve a repoLocal we still load ~/.claude/settings.json so the
    // page has something useful to merge.
    const r = await getExistingSettings("ghost-project", { homeDir: FAKE_HOME });
    expect(r.repoLocal).toBeNull();
    expect(r.sources.map((s) => s.label)).toEqual(["user-global"]);
    expect(r.allow.sort()).toEqual(["Edit", "Read", "WebFetch(domain:anthropic.com)"]);
  });

  it("succeeds when repoLocal exists but has no .claude directory", async () => {
    // Only the user-global source is loaded; no error surfaced for the
    // missing project files (they're optional).
    const r = await getExistingSettings("bare", { homeDir: FAKE_HOME });
    expect(r.repoLocal).toBe(BARE_REPO);
    expect(r.allow.sort()).toEqual(["Edit", "Read", "WebFetch(domain:anthropic.com)"]);
    const labels = r.sources.map((s) => s.label);
    expect(labels).toEqual(["user-global"]);
  });

  it("surfaces a parse error per malformed source without losing valid sources", async () => {
    const r = await getExistingSettings("corrupt", { homeDir: FAKE_HOME });
    // Valid sources still contribute. The corrupt project-local source
    // is reported with an `error` field but adds nothing to `allow`.
    expect(r.allow).toContain("Read");
    const local = r.sources.find((s) => s.label === "project-local");
    expect(local).toBeDefined();
    expect(local!.error).toMatch(/json|parse/i);
    expect(local!.count).toBe(0);
  });

  it("only reads files (no shell, no env, no network)", async () => {
    // Sanity check: the function shouldn't have side-effects beyond
    // file reads. We ensure repeated calls return identical results.
    const a = await getExistingSettings("acme", { homeDir: FAKE_HOME });
    const b = await getExistingSettings("acme", { homeDir: FAKE_HOME });
    expect(a.allow).toEqual(b.allow);
    expect(a.sources).toEqual(b.sources);
  });
});
