import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIngestor } from "../src/server";
import type { Server } from "node:http";

// Per-principal rate limiting (§5): cap request volume per authenticated
// developer so a single credential can't flood the ingestor.
describe("Ingestor server — per-principal rate limiting", () => {
  const PORT = 19889;
  let server: Server;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "observer-ratelimit-"));
    server = await createIngestor({
      port: PORT,
      dataDir,
      apiKeys: { key_a: "alice@acme.com", key_b: "bob@acme.com" },
      rateLimit: { windowMs: 60_000, maxRequests: 2 },
    });
  });

  afterAll(() => server?.close());

  function post(key: string, project: string) {
    return fetch(`http://localhost:${PORT}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        developer: key === "key_a" ? "alice@acme.com" : "bob@acme.com",
        machine: "m",
        agent: "claude_code",
        project,
        sourceFile: "f",
        shippedAt: "2026-06-09T00:00:00Z",
        entries: ["{}"],
      }),
    });
  }

  it("429s once a developer exceeds maxRequests within the window", async () => {
    expect((await post("key_a", "r1")).status).toBe(200);
    expect((await post("key_a", "r2")).status).toBe(200);
    const blocked = await post("key_a", "r3");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("limits are per-principal — a different developer is unaffected", async () => {
    // alice is already over her limit from the previous test; bob is fresh.
    expect((await post("key_b", "b1")).status).toBe(200);
    expect((await post("key_a", "a-again")).status).toBe(429);
  });
});
