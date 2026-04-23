import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon, type DaemonConfig } from "../src/daemon";
import type { ShippedBatch } from "../src/shipper";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-daemon-"));
}

function setupFakeClaudeTrace(dir: string, lines: string[]): string {
  const projectDir = join(dir, "projects", "test-proj");
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("Daemon", () => {
  let stateDir: string;
  let claudeDir: string;
  let shipped: ShippedBatch[];

  beforeEach(() => {
    stateDir = makeTmpDir();
    claudeDir = makeTmpDir();
    shipped = [];
  });

  function makeConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
    return {
      claudeDir,
      codexDir: "/nonexistent",
      cursorDir: "/nonexistent",
      stateDir,
      pollIntervalMs: 100,
      redactSecrets: true,
      developer: "test@example.com",
      onShip: async (batch) => { shipped.push(batch); },
      ...overrides,
    };
  }

  it("processes traces on pollOnce()", async () => {
    setupFakeClaudeTrace(claudeDir, [
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);

    const daemon = new Daemon(makeConfig());
    await daemon.pollOnce();

    expect(shipped).toHaveLength(1);
    expect(shipped[0].agent).toBe("claude_code");
    expect(shipped[0].developer).toBe("test@example.com");
  });

  it("deduplicates across polls", async () => {
    setupFakeClaudeTrace(claudeDir, [
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);

    const daemon = new Daemon(makeConfig());
    await daemon.pollOnce();
    const firstCount = shipped.length;

    await daemon.pollOnce();
    expect(shipped.length).toBe(firstCount); // no new data
  });

  it("picks up new entries on subsequent polls", async () => {
    const file = setupFakeClaudeTrace(claudeDir, [
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:00:00Z", message: { content: [{ type: "text", text: "first" }] } }),
    ]);

    const daemon = new Daemon(makeConfig());
    await daemon.pollOnce();
    const firstEntries = shipped.reduce((s, b) => s + b.entries.length, 0);

    // Append new entry
    appendFileSync(file,
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:01:00Z", message: { content: [{ type: "text", text: "second" }] } }) + "\n",
    );

    await daemon.pollOnce();
    const totalEntries = shipped.reduce((s, b) => s + b.entries.length, 0);
    expect(totalEntries).toBeGreaterThan(firstEntries);
  });

  it("redacts secrets by default", async () => {
    setupFakeClaudeTrace(claudeDir, [
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:00:00Z", message: { content: [{ type: "text", text: "key: AKIAIOSFODNN7EXAMPLE" }] } }),
    ]);

    const daemon = new Daemon(makeConfig());
    await daemon.pollOnce();

    const allContent = shipped.flatMap((b) => b.entries).join("");
    expect(allContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(allContent).toContain("[REDACTED:");
  });

  it("emits progress events", async () => {
    setupFakeClaudeTrace(claudeDir, [
      JSON.stringify({ type: "user", timestamp: "2026-04-08T10:00:00Z", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);

    const progress: string[] = [];
    const daemon = new Daemon(makeConfig({
      onProgress: (msg) => progress.push(msg),
    }));
    await daemon.pollOnce();

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.includes("source"))).toBe(true);
  });

  it("processes Cursor SQLite when localOutputDir is set", async () => {
    const Database = require("better-sqlite3");

    // Set up a Cursor-like directory with a workspace state.vscdb
    const cursorDir = makeTmpDir();
    const wsDir = join(cursorDir, "User", "workspaceStorage", "ws1");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const db = new Database(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:comp-1",
      JSON.stringify({ _v: 3, composerId: "comp-1", createdAt: 1712592000000 }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:comp-1:b1",
      JSON.stringify({ _v: 2, bubbleId: "b1", type: 1, text: "cursor message" }),
    );
    db.close();

    const localOutputDir = makeTmpDir();
    const daemon = new Daemon(makeConfig({
      cursorDir,
      localOutputDir,
      disclosure: "sensitive",
    }));
    await daemon.pollOnce();

    // Should have written to localOutputDir — date from entry timestamp
    // createdAt 1712592000000 = 2024-04-08 UTC
    const entryDate = "2024-04-08";
    const cursorOutputDir = join(localOutputDir, entryDate, "cursor");
    expect(existsSync(cursorOutputDir)).toBe(true);

    const files = readdirSync(cursorOutputDir).filter(f => f.endsWith(".jsonl"));
    expect(files.length).toBe(1);

    const content = readFileSync(join(cursorOutputDir, files[0]), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.agent).toBe("cursor");
    expect(entry.userPrompt).toBe("cursor message");
  });

  it("skips Cursor when localOutputDir is not set", async () => {
    const Database = require("better-sqlite3");

    const cursorDir = makeTmpDir();
    const wsDir = join(cursorDir, "User", "workspaceStorage", "ws1");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const db = new Database(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:comp-1",
      JSON.stringify({ _v: 3, composerId: "comp-1", createdAt: 1712592000000 }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:comp-1:b1",
      JSON.stringify({ _v: 2, bubbleId: "b1", type: 1, text: "cursor message" }),
    );
    db.close();

    // No localOutputDir → Cursor should be silently skipped
    const daemon = new Daemon(makeConfig({ cursorDir }));
    await daemon.pollOnce();

    // No crash, no Cursor data shipped via onShip
    const cursorBatches = shipped.filter(b => b.agent === "cursor");
    expect(cursorBatches).toHaveLength(0);
  });
});
