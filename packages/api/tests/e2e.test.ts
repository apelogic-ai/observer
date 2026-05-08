/**
 * E2E test: observer agent → ingestor server → stored in lakehouse.
 *
 * Spins up a real ingestor server, creates fake trace data,
 * runs the agent shipper against it, verifies data landed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import type { Server } from "node:http";

// Agent modules
import { Shipper } from "../../agent/src/shipper";
import { createHttpShipper } from "../../agent/src/http-shipper";
import { generateKeypair, loadKeypair, getPublicKeyFingerprint } from "../../agent/src/identity";

// Ingestor modules
import { createIngestor } from "../src/server";

const PORT = 19878;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-e2e-"));
}

describe("E2E: agent → ingestor → lakehouse", () => {
  let server: Server;
  let lakehouseDir: string;
  let agentStateDir: string;
  let keyDir: string;

  beforeAll(async () => {
    lakehouseDir = makeTmpDir();
    agentStateDir = makeTmpDir();
    keyDir = makeTmpDir();

    // Generate agent keypair
    generateKeypair(keyDir);
    const kp = loadKeypair(keyDir)!;
    const fp = getPublicKeyFingerprint(kp.publicKeyPem);

    // Start ingestor with the agent's public key registered
    server = await createIngestor({
      port: PORT,
      dataDir: lakehouseDir,
      trustedKeys: { [fp]: kp.publicKeyPem },
      apiKeys: ["key_e2e_test"],
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("agent ships trace data to ingestor via API key", async () => {
    // Create fake trace file
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "e2e-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "session.jsonl");
    writeFileSync(
      traceFile,
      [
        JSON.stringify({ type: "user", timestamp: "2026-04-08T20:00:00Z", message: { content: [{ type: "text", text: "E2E test message" }] } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-04-08T20:00:01Z", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hello" } }], usage: { input_tokens: 100, output_tokens: 50 } } }),
      ].join("\n") + "\n",
    );

    // Create shipper with HTTP backend
    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });

    const shipper = new Shipper({
      developer: "e2e-developer@acme.com",
      machine: "e2e-machine",
      stateDir: agentStateDir,
      redactSecrets: true,
      ship: httpShip,
    });

    // Process the trace file
    shipper.processFile(traceFile, "claude_code", "e2e-proj");

    // Wait for async ship to complete
    await new Promise((r) => setTimeout(r, 100));

    // Verify data landed in the lakehouse
    const jsonlFiles = findFiles(join(lakehouseDir, "raw"), ".jsonl");
    expect(jsonlFiles.length).toBeGreaterThanOrEqual(1);

    const content = readFileSync(jsonlFiles[0], "utf-8");
    expect(content).toContain("E2E test message");
    expect(content).toContain("echo hello");
    expect(jsonlFiles[0]).toContain("agent=claude_code");

    // Verify metadata
    const metaFiles = findFiles(join(lakehouseDir, "raw"), ".meta.json");
    const meta = JSON.parse(readFileSync(metaFiles[0], "utf-8"));
    expect(meta.developer).toBe("e2e-developer@acme.com");
    expect(meta.machine).toBe("e2e-machine");
    expect(meta.agent).toBe("claude_code");
    expect(meta.entryCount).toBe(2);
  });

  it("agent ships signed data to ingestor via Ed25519", async () => {
    const kp = loadKeypair(keyDir)!;

    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "signed-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "signed.jsonl");
    writeFileSync(
      traceFile,
      JSON.stringify({ type: "user", timestamp: "2026-04-08T21:00:00Z", message: { content: [{ type: "text", text: "Signed E2E" }] } }) + "\n",
    );

    const signedStateDir = makeTmpDir();

    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      keypair: kp,
    });

    const shipper = new Shipper({
      developer: "signer@acme.com",
      machine: "sign-machine",
      stateDir: signedStateDir,
      redactSecrets: false,
      ship: httpShip,
    });

    shipper.processFile(traceFile, "codex", "signed-proj");
    await new Promise((r) => setTimeout(r, 100));

    // Verify in lakehouse
    const metaFiles = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) => f.includes("agent=codex"));
    expect(metaFiles.length).toBeGreaterThanOrEqual(1);

    const meta = JSON.parse(readFileSync(metaFiles[0], "utf-8"));
    expect(meta.developer).toBe("signer@acme.com");
  });

  it("splits a multi-batch file by entry count and ships every batch", async () => {
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "multi-batch-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "multi.jsonl");
    // 11 entries with maxBatchEntries=4 → 4 + 4 + 3 = 3 batches.
    let content = "";
    for (let i = 0; i < 11; i++) {
      content += JSON.stringify({
        type: "user",
        i,
        timestamp: `2026-04-09T00:00:${String(i).padStart(2, "0")}Z`,
      }) + "\n";
    }
    writeFileSync(traceFile, content);

    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });
    const shipper = new Shipper({
      developer: "multi-batch-dev@acme.com",
      machine: "m",
      stateDir: makeTmpDir(),
      redactSecrets: false,
      maxBatchEntries: 4,
      ship: httpShip,
    });

    const n = await shipper.processFile(traceFile, "claude_code", "multi-batch-proj");
    expect(n).toBe(3);

    const metaFiles = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) =>
      readFileSync(f, "utf-8").includes("multi-batch-dev@acme.com"),
    );
    expect(metaFiles).toHaveLength(3);
    const totalEntries = metaFiles.reduce(
      (sum, f) => sum + JSON.parse(readFileSync(f, "utf-8")).entryCount,
      0,
    );
    expect(totalEntries).toBe(11);
  });

  it("splits on the byte budget when entries are large (the bug from #20 fix)", async () => {
    // Each entry ~700 bytes; budget 2000 bytes → byte cap drives splits
    // long before the entry count cap (1000) would trigger. Confirms the
    // agent → ingestor → lakehouse round-trip works for byte-bounded batches.
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "byte-split-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "fat.jsonl");
    const big = "x".repeat(600);
    let content = "";
    for (let i = 0; i < 10; i++) content += JSON.stringify({ type: "user", i, big }) + "\n";
    writeFileSync(traceFile, content);

    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });
    const shipper = new Shipper({
      developer: "byte-split-dev@acme.com",
      machine: "m",
      stateDir: makeTmpDir(),
      redactSecrets: false,
      maxBatchEntries: 1000,
      maxBatchBytes: 2000,
      ship: httpShip,
    });

    const n = await shipper.processFile(traceFile, "claude_code", "byte-split-proj");
    expect(n).toBeGreaterThanOrEqual(3);

    const metaFiles = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) =>
      readFileSync(f, "utf-8").includes("byte-split-dev@acme.com"),
    );
    const totalEntries = metaFiles.reduce(
      (sum, f) => sum + JSON.parse(readFileSync(f, "utf-8")).entryCount,
      0,
    );
    expect(totalEntries).toBe(10);
  });

  it("recovers across polls — failed batch retries on the next pass", async () => {
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "retry-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "retry.jsonl");
    writeFileSync(traceFile, JSON.stringify({ type: "user", text: "retry-payload" }) + "\n");

    const stateDir = makeTmpDir();

    // First poll: wrong key → 401 → offset stays put.
    const wrongShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "wrong-key",
    });
    const origErr = console.error;
    console.error = () => {};
    try {
      const failing = new Shipper({
        developer: "retry-dev@acme.com",
        machine: "m",
        stateDir,
        redactSecrets: false,
        ship: wrongShip,
      });
      expect(await failing.processFile(traceFile, "claude_code", "retry-proj")).toBe(0);
    } finally {
      console.error = origErr;
    }

    // Second poll: right key → success, offset advances.
    const rightShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });
    const good = new Shipper({
      developer: "retry-dev@acme.com",
      machine: "m",
      stateDir,
      redactSecrets: false,
      ship: rightShip,
    });
    expect(await good.processFile(traceFile, "claude_code", "retry-proj")).toBe(1);

    // Third poll: offset advanced — nothing new.
    expect(await good.processFile(traceFile, "claude_code", "retry-proj")).toBe(0);

    const metaFiles = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) =>
      readFileSync(f, "utf-8").includes("retry-dev@acme.com"),
    );
    expect(metaFiles).toHaveLength(1);
  });

  it("holds back an incomplete trailing line until the file completes it", async () => {
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "partial-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "partial.jsonl");
    // 2 complete lines + 1 partial (no trailing \n) — file is mid-write.
    writeFileSync(
      traceFile,
      JSON.stringify({ type: "user", i: 1 }) + "\n" +
      JSON.stringify({ type: "user", i: 2 }) + "\n" +
      '{"type":"user","i":',
    );

    const stateDir = makeTmpDir();
    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });
    const shipper = new Shipper({
      developer: "partial-dev@acme.com",
      machine: "m",
      stateDir,
      redactSecrets: false,
      ship: httpShip,
    });

    await shipper.processFile(traceFile, "claude_code", "partial-proj");
    const firstMetas = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) =>
      readFileSync(f, "utf-8").includes("partial-dev@acme.com"),
    );
    expect(firstMetas).toHaveLength(1);
    expect(JSON.parse(readFileSync(firstMetas[0], "utf-8")).entryCount).toBe(2);

    // Complete the partial line and add another.
    writeFileSync(
      traceFile,
      JSON.stringify({ type: "user", i: 1 }) + "\n" +
      JSON.stringify({ type: "user", i: 2 }) + "\n" +
      JSON.stringify({ type: "user", i: 3 }) + "\n" +
      JSON.stringify({ type: "user", i: 4 }) + "\n",
    );
    await shipper.processFile(traceFile, "claude_code", "partial-proj");

    const secondMetas = findFiles(join(lakehouseDir, "raw"), ".meta.json").filter((f) =>
      readFileSync(f, "utf-8").includes("partial-dev@acme.com"),
    );
    expect(secondMetas).toHaveLength(2);
    const total = secondMetas.reduce(
      (s, f) => s + JSON.parse(readFileSync(f, "utf-8")).entryCount,
      0,
    );
    expect(total).toBe(4);
  });

  it("secret redaction works end-to-end", async () => {
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "secrets-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "secrets.jsonl");
    writeFileSync(
      traceFile,
      JSON.stringify({ type: "user", timestamp: "2026-04-08T22:00:00Z", message: { content: [{ type: "text", text: "key: AKIAIOSFODNN7EXAMPLE" }] } }) + "\n",
    );

    const secretsStateDir = makeTmpDir();
    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });

    const shipper = new Shipper({
      developer: "secrets-dev",
      stateDir: secretsStateDir,
      redactSecrets: true,
      ship: httpShip,
    });

    shipper.processFile(traceFile, "claude_code", "secrets-proj");
    await new Promise((r) => setTimeout(r, 100));

    // Verify the secret was redacted in the lakehouse
    const jsonlFiles = findFiles(join(lakehouseDir, "raw"), ".jsonl");
    const allContent = jsonlFiles.map((f) => readFileSync(f, "utf-8")).join("\n");

    expect(allContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(allContent).toContain("[REDACTED:aws_access_key]");
  });
});

describe("E2E: body-cap surfaces a clean 413 to the agent (the bug from #21 fix)", () => {
  const SMALL_PORT = 19880;
  const SMALL_CAP = 2048;
  let server: Server;

  beforeAll(async () => {
    server = await createIngestor({
      port: SMALL_PORT,
      dataDir: makeTmpDir(),
      apiKeys: ["key_e2e_test"],
      maxBodyBytes: SMALL_CAP,
    });
  });

  afterAll(() => server?.close());

  it("agent gets a 413 (not a 502 / connection drop) when a batch exceeds the body cap", async () => {
    const traceDir = makeTmpDir();
    const projectDir = join(traceDir, "projects", "oversize-proj");
    mkdirSync(projectDir, { recursive: true });
    const traceFile = join(projectDir, "oversize.jsonl");
    // 5 entries × ~700 bytes ≈ 3.5 KB raw — comfortably over the 2 KiB cap.
    const big = "x".repeat(700);
    let content = "";
    for (let i = 0; i < 5; i++) content += JSON.stringify({ i, big }) + "\n";
    writeFileSync(traceFile, content);

    const httpShip = createHttpShipper({
      endpoint: `http://localhost:${SMALL_PORT}/api/ingest`,
      apiKey: "key_e2e_test",
    });
    // Disable the agent's own byte cap so we deliberately produce a too-big
    // batch — we're exercising the ingestor's overflow path here.
    const shipper = new Shipper({
      developer: "oversize-dev@acme.com",
      machine: "m",
      stateDir: makeTmpDir(),
      redactSecrets: false,
      maxBatchEntries: 1000,
      maxBatchBytes: 1_000_000,
      ship: httpShip,
    });

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

    try {
      const n = await shipper.processFile(traceFile, "claude_code", "oversize-proj");
      expect(n).toBe(0);
    } finally {
      console.error = origErr;
    }

    const combined = errors.join("\n");
    expect(combined).toContain("413");
    expect(combined).toContain("body too large");
    // The original symptom — must not regress.
    expect(combined).not.toContain("502");
    expect(combined).not.toContain("ECONNRESET");
  });
});
