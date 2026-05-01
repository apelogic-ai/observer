import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../../server/db";

/**
 * P1 from the review: dashboard API must not return
 * `Access-Control-Allow-Origin: *`. The dashboard UI is served from the
 * same origin (localhost:3457); the wildcard only enabled cross-origin
 * reads of session prompts and assistant text from any website the user
 * happened to visit.
 *
 * These tests start a real Bun server bound to a free port, hit a
 * representative API route, and assert the absence of the wildcard
 * header. Restore the wildcard header in server/index.ts and they fail.
 */

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = `${TODAY}T09:00:00Z`;

let dataDir: string;
let started: { server: { stop: () => Promise<void> | void }; port: number };

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "observer-cors-"));
  // Minimal fixture so /api/stats returns successfully.
  mkdirSync(join(dataDir, TODAY, "claude_code"), { recursive: true });
  writeFileSync(
    join(dataDir, TODAY, "claude_code", "session.jsonl"),
    JSON.stringify({
      id: "x", timestamp: T0, agent: "claude_code", sessionId: "s1",
      project: "alpha", entryType: "message", role: "assistant",
      tokenUsage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    }) + "\n",
  );

  await initDb(dataDir);

  const { start } = await import("../../server/index");
  const staticDir = mkdtempSync(join(tmpdir(), "observer-cors-static-"));
  writeFileSync(join(staticDir, "index.html"), "<html></html>");

  // start() reads CLI args from process.argv; shim them.
  const oldArgv = process.argv;
  process.argv = [
    "bun", "server",
    "--port", "0",
    "--data-dir", dataDir,
    "--static-dir", staticDir,
    "--bind", "127.0.0.1",
    "--log-level", "silent",
  ];
  try {
    started = await start();
  } finally {
    process.argv = oldArgv;
  }
});

afterAll(async () => {
  if (started?.server?.stop) await started.server.stop();
});

describe("dashboard CORS posture", () => {
  it("does NOT return Access-Control-Allow-Origin: * on /api routes", async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/api/stats`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does NOT return Access-Control-Allow-Origin: * on the OPTIONS preflight", async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/api/stats`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does NOT return Access-Control-Allow-Origin: * on a 404 from /api/", async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/api/does-not-exist`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
