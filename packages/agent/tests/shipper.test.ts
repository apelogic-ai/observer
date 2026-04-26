import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Shipper, type ShipperConfig, type ShippedBatch } from "../src/shipper";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-shipper-"));
}

describe("Shipper", () => {
  let stateDir: string;
  let config: ShipperConfig;
  let shipped: ShippedBatch[];

  beforeEach(() => {
    stateDir = makeTmpDir();
    shipped = [];
    config = {
      developer: "test-user@example.com",
      machine: "test-machine",
      stateDir,
      ship: async (batch) => {
        shipped.push(batch);
      },
    };
  });

  it("tracks cursor per file — only ships new lines", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n{"line":2}\n');

    const shipper = new Shipper(config);
    await shipper.processFile(traceFile, "claude_code", "test-project");

    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries).toHaveLength(2);

    // Append more lines
    writeFileSync(traceFile, '{"line":1}\n{"line":2}\n{"line":3}\n');
    shipped = [];

    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries).toHaveLength(1);
    expect(shipped[0].entries[0]).toContain('"line":3');
  });

  it("persists cursor across instances", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n{"line":2}\n');

    const shipper1 = new Shipper(config);
    await shipper1.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(1);

    shipped = [];
    const shipper2 = new Shipper(config);
    await shipper2.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(0);
  });

  it("redacts secrets before shipping", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"content":"key: AKIAIOSFODNN7EXAMPLE"}\n');

    const shipper = new Shipper({ ...config, redactSecrets: true });
    await shipper.processFile(traceFile, "claude_code", "test-project");

    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries[0]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(shipped[0].entries[0]).toContain("[REDACTED:aws_access_key]");
  });

  it("includes developer, machine, and batchId", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n');

    const shipper = new Shipper(config);
    await shipper.processFile(traceFile, "claude_code", "test-project");

    expect(shipped[0].developer).toBe("test-user@example.com");
    expect(shipped[0].machine).toBe("test-machine");
    expect(shipped[0].batchId).toBeTruthy();
    expect(shipped[0].batchId.length).toBe(16);
  });

  it("does NOT advance cursor when ship fails", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n');

    let failCount = 0;
    const failingConfig: ShipperConfig = {
      ...config,
      ship: async () => {
        failCount++;
        throw new Error("Network error");
      },
    };

    const shipper = new Shipper(failingConfig);
    const result = await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(result).toBe(0);
    expect(failCount).toBe(1);

    // Retry — should attempt again (cursor was NOT advanced)
    const result2 = await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(result2).toBe(0);
    expect(failCount).toBe(2);
  });

  it("advances cursor when ship succeeds after previous failure", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n');

    let callCount = 0;
    const retryConfig: ShipperConfig = {
      ...config,
      ship: async (batch) => {
        callCount++;
        if (callCount === 1) throw new Error("First call fails");
        shipped.push(batch);
      },
    };

    const shipper = new Shipper(retryConfig);

    // First attempt fails
    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(0);

    // Second attempt succeeds
    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(1);

    // Third attempt — nothing new (cursor advanced)
    shipped = [];
    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(0);
  });

  it("generates deterministic batchId for same content", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "session.jsonl");
    writeFileSync(traceFile, '{"line":1}\n');

    let callCount = 0;
    const ids: string[] = [];
    const captureConfig: ShipperConfig = {
      ...config,
      ship: async (batch) => {
        callCount++;
        ids.push(batch.batchId);
        if (callCount === 1) throw new Error("Fail first");
      },
    };

    const shipper = new Shipper(captureConfig);
    await shipper.processFile(traceFile, "claude_code", "test-project");
    await shipper.processFile(traceFile, "claude_code", "test-project");

    // Same content → same batchId on retry
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("resolves developer from git config when not set", () => {
    const shipper = new Shipper({ stateDir, ship: async () => {} });
    expect(shipper.developer).toBeTruthy();
    expect(shipper.developer).not.toBe("unknown");
  });

  it("resolves machine from hostname when not set", () => {
    const shipper = new Shipper({ stateDir, ship: async () => {} });
    expect(shipper.machine).toBeTruthy();
  });

  it("handles empty files", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "empty.jsonl");
    writeFileSync(traceFile, "");

    const shipper = new Shipper(config);
    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(0);
  });

  it("skips invalid JSON lines", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "messy.jsonl");
    writeFileSync(traceFile, '{"good":1}\nnot json\n{"good":2}\n');

    const shipper = new Shipper(config);
    await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries).toHaveLength(2);
  });

  // ── Streaming behavior (replaces the old 200MB-skip path) ────────

  it("ships a multi-batch file in chunks of maxBatchEntries", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "big.jsonl");
    // 13 lines, batch size 5 → expect 3 batches (5 + 5 + 3)
    let content = "";
    for (let i = 0; i < 13; i++) content += `{"i":${i}}\n`;
    writeFileSync(traceFile, content);

    const shipper = new Shipper({ ...config, maxBatchEntries: 5 });
    const n = await shipper.processFile(traceFile, "claude_code", "test-project");

    expect(n).toBe(3);
    expect(shipped).toHaveLength(3);
    expect(shipped[0].entries).toHaveLength(5);
    expect(shipped[1].entries).toHaveLength(5);
    expect(shipped[2].entries).toHaveLength(3);
    // Each batch has a different deterministic batchId
    const ids = new Set(shipped.map((b) => b.batchId));
    expect(ids.size).toBe(3);
  });

  it("does NOT advance offset past an incomplete trailing line", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "appended.jsonl");
    // First write: 2 complete + 1 incomplete (no trailing \n).
    writeFileSync(traceFile, '{"a":1}\n{"a":2}\n{"part":');

    const shipper = new Shipper(config);
    const first = await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(first).toBe(1);
    expect(shipped[0].entries).toHaveLength(2);

    // Now complete the trailing line + add another. Offset should pick up
    // from before the partial line and ship both new completed lines.
    shipped = [];
    writeFileSync(traceFile, '{"a":1}\n{"a":2}\n{"part":3}\n{"a":4}\n');
    const second = await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(second).toBe(1);
    expect(shipped[0].entries).toHaveLength(2);
    expect(shipped[0].entries[0]).toContain('"part":3');
    expect(shipped[0].entries[1]).toContain('"a":4');
  });

  it("stops shipping mid-stream on failure; offset reflects last good batch", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "fail-mid.jsonl");
    let content = "";
    for (let i = 0; i < 10; i++) content += `{"i":${i}}\n`;
    writeFileSync(traceFile, content);

    let callCount = 0;
    const failingConfig: ShipperConfig = {
      ...config,
      maxBatchEntries: 3,
      ship: async (batch) => {
        callCount++;
        if (callCount === 2) throw new Error("fail mid-stream");
        shipped.push(batch);
      },
    };
    const shipper = new Shipper(failingConfig);
    const n = await shipper.processFile(traceFile, "claude_code", "test-project");

    // Batch 1 succeeded (3 entries). Batch 2 failed → stop.
    expect(n).toBe(1);
    expect(shipped).toHaveLength(1);
    expect(shipped[0].entries).toHaveLength(3);

    // Retry — should pick up after the first 3 entries.
    shipped = [];
    callCount = 0;
    const retryConfig: ShipperConfig = {
      ...config,
      maxBatchEntries: 3,
      ship: async (batch) => { shipped.push(batch); },
    };
    // Need a fresh Shipper to pick up persisted offset.
    const retryShipper = new Shipper(retryConfig);
    const n2 = await retryShipper.processFile(traceFile, "claude_code", "test-project");
    // 7 remaining → batches of 3, 3, 1
    expect(n2).toBe(3);
    expect(shipped[0].entries[0]).toContain('"i":3');
  });

  it("handles a file with no size limit (formerly 200MB skip path)", async () => {
    const traceDir = makeTmpDir();
    const traceFile = join(traceDir, "many.jsonl");
    // 50,000 small lines — would previously have been at risk of large-string
    // blowup; with streaming we just process them in batches.
    let content = "";
    for (let i = 0; i < 50_000; i++) content += `{"i":${i}}\n`;
    writeFileSync(traceFile, content);

    const shipper = new Shipper({ ...config, maxBatchEntries: 10_000 });
    const n = await shipper.processFile(traceFile, "claude_code", "test-project");
    expect(n).toBe(5);
    expect(shipped[0].entries).toHaveLength(10_000);
    expect(shipped[4].entries).toHaveLength(10_000);
  });
});
