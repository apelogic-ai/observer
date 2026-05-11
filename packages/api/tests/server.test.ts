import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Recursively find files matching a suffix. */
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
import { createIngestor, type IngestorConfig } from "../src/server";
import type { Server } from "node:http";

// Reuse identity module from the agent package for signing in tests
import { generateKeypair, loadKeypair, signPayload, getPublicKeyFingerprint } from "../../agent/src/identity";

const PORT = 19877;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-api-"));
}

describe("Ingestor server", () => {
  let dataDir: string;
  let server: Server;
  let keyDir: string;

  beforeAll(async () => {
    dataDir = makeTmpDir();
    keyDir = makeTmpDir();
    generateKeypair(keyDir);

    const kp = loadKeypair(keyDir)!;
    const fp = getPublicKeyFingerprint(kp.publicKeyPem);

    const config: IngestorConfig = {
      port: PORT,
      dataDir,
      // Register the test key. Tenant binding (OBS-004) means each
      // credential maps to a developer; the test fixtures below
      // post batches with developer="alice@acme.com" so we bind
      // both auth methods to that identity.
      trustedKeys: { [fp]: { developer: "alice@acme.com", publicKeyPem: kp.publicKeyPem } },
      apiKeys: { "key_test_valid": "alice@acme.com" },
    };
    server = await createIngestor(config);
  });

  afterAll(() => {
    server?.close();
  });

  const baseUrl = `http://localhost:${PORT}`;

  async function post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  it("accepts a valid batch with API key auth", async () => {
    const batch = {
      developer: "alice@acme.com",
      machine: "alice-mac",
      agent: "claude_code",
      project: "test-proj",
      sourceFile: "/tmp/session.jsonl",
      shippedAt: "2026-04-08T17:00:00Z",
      entries: ['{"type":"user"}'],
    };

    const res = await post("/api/ingest", batch, {
      Authorization: "Bearer key_test_valid",
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).status).toBe("ok");
  });

  it("rejects request without auth", async () => {
    const res = await post("/api/ingest", {
      developer: "x",
      machine: "m",
      agent: "claude_code",
      project: "p",
      sourceFile: "f",
      shippedAt: "2026-04-08T17:00:00Z",
      entries: ["{}"],
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid API key", async () => {
    const res = await post(
      "/api/ingest",
      { developer: "x", machine: "m", agent: "a", project: "p", sourceFile: "f", shippedAt: "t", entries: ["{}"] },
      { Authorization: "Bearer key_wrong" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts batch with valid Ed25519 signature", async () => {
    const kp = loadKeypair(keyDir)!;
    // The trustedKey is bound to alice@acme.com — tenant binding
    // (OBS-004) requires the batch's developer to match. The
    // separate tenant-binding.test.ts covers the mismatch branch.
    const batch = {
      developer: "alice@acme.com",
      machine: "bob-pc",
      agent: "codex",
      project: "signed-proj",
      sourceFile: "/tmp/f.jsonl",
      shippedAt: "2026-04-08T18:00:00Z",
      entries: ['{"signed":true}'],
    };
    const body = JSON.stringify(batch);
    const sig = signPayload(body, kp);
    const fp = getPublicKeyFingerprint(kp.publicKeyPem);

    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Observer-Signature": sig,
        "X-Observer-Key-Fingerprint": fp,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  it("rejects tampered batch with valid signature", async () => {
    const kp = loadKeypair(keyDir)!;
    const batch = { developer: "carol", machine: "m", agent: "claude_code", project: "p", sourceFile: "f", shippedAt: "t", entries: ["{}"] };
    const body = JSON.stringify(batch);
    const sig = signPayload(body, kp);
    const fp = getPublicKeyFingerprint(kp.publicKeyPem);

    // Tamper with the body
    const tampered = JSON.stringify({ ...batch, developer: "mallory" });

    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Observer-Signature": sig,
        "X-Observer-Key-Fingerprint": fp,
      },
      body: tampered,
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown key fingerprint", async () => {
    const unknownKeyDir = makeTmpDir();
    generateKeypair(unknownKeyDir);
    const unknownKp = loadKeypair(unknownKeyDir)!;

    const batch = { developer: "eve", machine: "m", agent: "codex", project: "p", sourceFile: "f", shippedAt: "t", entries: ["{}"] };
    const body = JSON.stringify(batch);
    const sig = signPayload(body, unknownKp);
    const fp = getPublicKeyFingerprint(unknownKp.publicKeyPem);

    const res = await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Observer-Signature": sig,
        "X-Observer-Key-Fingerprint": fp,
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it("stores the batch in the lakehouse", async () => {
    const batch = {
      // Must match the api key's bound developer (OBS-004).
      developer: "alice@acme.com",
      machine: "m",
      agent: "claude_code",
      project: "store-test",
      sourceFile: "/tmp/s.jsonl",
      shippedAt: "2026-04-08T19:00:00Z",
      entries: ['{"stored":true}', '{"stored":2}'],
    };

    await post("/api/ingest", batch, { Authorization: "Bearer key_test_valid" });

    const jsonlFiles = findFiles(join(dataDir, "raw"), ".jsonl");
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);

    // Find the file containing our test data
    const storedFile = jsonlFiles.find((f) =>
      readFileSync(f, "utf-8").includes('"stored":true')
    );
    expect(storedFile).toBeDefined();
    expect(storedFile!).toContain("agent=claude_code");
  });

  it("returns health check on GET /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("Ingestor server — large bodies", () => {
  // The prod stall traced to a single 8.27 MiB Codex `compacted` event —
  // a real, expected payload shape, not a malicious upload. Once we raise
  // the cap, the ingestor needs to handle bodies of that size cleanly.
  const LARGE_PORT = 19881;
  const LARGE_CAP = 32 * 1024 * 1024;
  let server: Server;

  beforeAll(async () => {
    const dataDir = makeTmpDir();
    server = await createIngestor({
      port: LARGE_PORT,
      dataDir,
      apiKeys: { "key_test_valid": "large-body@acme.com" },
      maxBodyBytes: LARGE_CAP,
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("accepts a 12 MiB batch when maxBodyBytes is sized for it", async () => {
    // One ~10 MiB entry — over the historical 8 MiB cap, well under the
    // 32 MiB target. JSON-stringified once into entries[], then again into
    // the batch envelope, so the wire body is ~10 MiB + framing overhead.
    const big = "x".repeat(10 * 1024 * 1024);
    const body = JSON.stringify({
      developer: "large-body@acme.com",
      machine: "m",
      agent: "codex",
      project: "p",
      sourceFile: "f",
      shippedAt: "2026-05-08T00:00:00Z",
      entries: [JSON.stringify({ type: "compacted", payload: big })],
    });
    expect(body.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(body.length).toBeLessThan(LARGE_CAP);

    const res = await fetch(`http://localhost:${LARGE_PORT}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer key_test_valid",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entryCount: number };
    expect(json.entryCount).toBe(1);
  });
});

describe("Ingestor server — body overflow", () => {
  // Separate instance on its own port with a tiny body cap so a small
  // payload triggers the overflow path.
  const OVERFLOW_PORT = 19879;
  const MAX_BYTES = 1024;
  let server: Server;

  beforeAll(async () => {
    const dataDir = makeTmpDir();
    server = await createIngestor({
      port: OVERFLOW_PORT,
      dataDir,
      apiKeys: { "key_test_valid": "x" },
      maxBodyBytes: MAX_BYTES,
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("returns 413 (not a connection drop) when the body exceeds maxBodyBytes", async () => {
    // Reproduces the prod 502: the agent shipped a 35 MB batch into an 8 MB
    // ingestor, and instead of seeing a clean 413 it got `Ingestor returned
    // 502:` from Caddy — because readBody called req.destroy() before the
    // 413 response could flush, killing the shared socket. Caddy then saw
    // an upstream that closed without responding and synthesized a 502.
    //
    // Build a body comfortably over the cap. Each entry is ~50 bytes;
    // 100 of them puts us well past 1 KiB.
    const entries = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ i, payload: "x".repeat(40) }),
    );
    const body = JSON.stringify({
      developer: "x",
      machine: "m",
      agent: "a",
      project: "p",
      sourceFile: "f",
      shippedAt: "t",
      entries,
    });
    expect(body.length).toBeGreaterThan(MAX_BYTES);

    const res = await fetch(`http://localhost:${OVERFLOW_PORT}/api/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer key_test_valid",
      },
      body,
    });
    expect(res.status).toBe(413);
  });
});
