import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIngestor } from "../src/server";

/**
 * OBS-004 (2026-05 security review): the ingestor's auth must bind
 * each credential to a developer identity. A caller with a valid
 * API key for "alice" must not be able to write batches whose
 * `developer` field says "bob" — otherwise any authenticated user
 * can pre-claim another developer's batchIds and cause their
 * legitimate batches to be silently dropped as duplicates.
 */

const PORT = 19911;

let server: Server | undefined;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "observer-tenant-"));
  server = await createIngestor({
    port: PORT,
    dataDir,
    apiKeys: {
      "key_alice": "alice@example.com",
      "key_bob":   "bob@example.com",
    },
  });
});

afterAll(() => server?.close());

async function postBatch(authKey: string, batch: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${PORT}/api/ingest`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${authKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
}

describe("tenant binding", () => {
  it("accepts a batch whose developer matches the authenticated key's tenant", async () => {
    const res = await postBatch("key_alice", {
      batchId: "alice-1", developer: "alice@example.com",
      agent: "claude_code", project: "alpha", entries: [],
    });
    expect(res.status).toBe(200);
  });

  it("REJECTS a batch whose developer doesn't match the authenticated key's tenant", async () => {
    // Alice's key tries to write under Bob's identity — the attack
    // the review flagged. The duplicate-protection logic must never
    // get a chance to run on this batch.
    const res = await postBatch("key_alice", {
      batchId: "would-poison-bob",
      developer: "bob@example.com",
      agent: "claude_code", project: "alpha", entries: [],
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/developer mismatch/i);
  });

  it("rejects unknown API keys with 401, not 403", async () => {
    // Disambiguates "wrong tenant" (403) from "no auth" (401).
    const res = await postBatch("key_nobody", {
      batchId: "x", developer: "alice@example.com",
      agent: "claude_code", project: "alpha", entries: [],
    });
    expect(res.status).toBe(401);
  });
});
