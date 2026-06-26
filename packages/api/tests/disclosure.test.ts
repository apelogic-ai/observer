import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIngestor } from "../src/server";
import { clampDisclosure, normalizeLevel } from "../src/disclosure";
import type { Server } from "node:http";

function findFiles(dir: string, suffix: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) results.push(full);
  }
  return results;
}

// A trace entry carrying content at every disclosure tier.
const richEntry = () => JSON.stringify({
  type: "tool",
  // moderate
  filePath: "/src/app.ts", command: "rm -rf /", gitBranch: "main",
  // sensitive
  userPrompt: "delete everything", assistantText: "ok", thinking: "hmm",
  // high-risk
  fileContent: "SECRET SOURCE", toolResultContent: "rows...", stdout: "done",
});

describe("clampDisclosure", () => {
  it("full → strips nothing", () => {
    const { stripped } = clampDisclosure(richEntry(), "full");
    expect(stripped).toEqual([]);
  });

  it("sensitive → strips high-risk only", () => {
    const { json, stripped } = clampDisclosure(richEntry(), "sensitive");
    const e = JSON.parse(json);
    expect(e.fileContent).toBeNull();
    expect(e.toolResultContent).toBeNull();
    expect(e.stdout).toBeNull();
    expect(e.userPrompt).toBe("delete everything"); // sensitive kept
    expect(e.filePath).toBe("/src/app.ts");          // moderate kept
    expect(stripped.sort()).toEqual(["fileContent", "stdout", "toolResultContent"]);
  });

  it("moderate → strips high-risk + sensitive", () => {
    const e = JSON.parse(clampDisclosure(richEntry(), "moderate").json);
    expect(e.fileContent).toBeNull();
    expect(e.userPrompt).toBeNull();
    expect(e.thinking).toBeNull();
    expect(e.filePath).toBe("/src/app.ts"); // moderate kept
    expect(e.command).toBe("rm -rf /");
  });

  it("basic → strips all three tiers", () => {
    const e = JSON.parse(clampDisclosure(richEntry(), "basic").json);
    expect(e.fileContent).toBeNull();
    expect(e.userPrompt).toBeNull();
    expect(e.filePath).toBeNull();
    expect(e.command).toBeNull();
    expect(e.type).toBe("tool"); // untiered field untouched
  });

  it("is idempotent — already-null fields aren't reported as stripped", () => {
    const once = clampDisclosure(richEntry(), "basic").json;
    const { stripped } = clampDisclosure(once, "basic");
    expect(stripped).toEqual([]);
  });

  it("non-JSON input is returned unchanged", () => {
    const { json, stripped } = clampDisclosure("not json {", "basic");
    expect(json).toBe("not json {");
    expect(stripped).toEqual([]);
  });

  it("normalizeLevel fails safe to basic on garbage", () => {
    expect(normalizeLevel("full")).toBe("full");
    expect(normalizeLevel("bogus")).toBe("basic");
    expect(normalizeLevel(undefined)).toBe("basic");
  });
});

// The ingestor must clamp regardless of what the client claims — this is the
// control against a root user raising disclosure in config.yaml.
describe("Ingestor — server-side disclosure floor", () => {
  const PORT = 19899;
  let dataDir: string;
  let server: Server;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "observer-disclosure-"));
    server = await createIngestor({
      port: PORT,
      dataDir,
      apiKeys: { key_test_valid: "alice@acme.com" },
      maxDisclosure: "basic",
    });
  });

  afterAll(() => server?.close());

  it("clamps full-content entries to the configured floor before storage", async () => {
    const batch = {
      developer: "alice@acme.com",
      machine: "m",
      agent: "claude_code",
      project: "disclosure-test",
      sourceFile: "/tmp/s.jsonl",
      shippedAt: "2026-06-09T00:00:00Z",
      entries: [richEntry()],
    };
    const res = await fetch(`http://localhost:${PORT}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer key_test_valid" },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(200);

    // The .jsonl holds only entries (project lives in .meta.json), and the
    // floor nulls every tiered field — so just read all stored entry files.
    const files = findFiles(join(dataDir, "raw"), ".jsonl");
    expect(files.length).toBeGreaterThan(0);
    const stored = files.map((f) => readFileSync(f, "utf-8")).join("\n");
    // High-risk + sensitive + moderate content must never have landed.
    expect(stored).not.toContain("SECRET SOURCE");
    expect(stored).not.toContain("delete everything");
    expect(stored).not.toContain("/src/app.ts");
    expect(stored).toContain('"fileContent":null');
  });
});
