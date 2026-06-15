import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIngestor } from "../src/server";
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

// Server-side redaction is a defence-in-depth backstop (§5 AI controls):
// the agent already redacts before shipping, but the ingestor must not
// persist secrets that an older/misbehaving client failed to scrub.
describe("Ingestor server — server-side secret redaction", () => {
  const PORT = 19888;
  let dataDir: string;
  let server: Server;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "observer-redact-"));
    server = await createIngestor({
      port: PORT,
      dataDir,
      apiKeys: { key_test_valid: "alice@acme.com" },
    });
  });

  afterAll(() => server?.close());

  it("redacts secrets in entries before they are persisted", async () => {
    const anthropic = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const batch = {
      developer: "alice@acme.com",
      machine: "m",
      agent: "claude_code",
      project: "redaction-test",
      sourceFile: "/tmp/s.jsonl",
      shippedAt: "2026-06-09T00:00:00Z",
      entries: [
        JSON.stringify({ type: "assistant", text: `key is ${anthropic} ok` }),
        JSON.stringify({ type: "tool", cmd: `aws --key ${awsKey}` }),
        JSON.stringify({ type: "user", text: "nothing secret here" }),
      ],
    };

    const res = await fetch(`http://localhost:${PORT}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer key_test_valid" },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(200);

    const stored = findFiles(join(dataDir, "raw"), ".jsonl")
      .map((f) => readFileSync(f, "utf-8"))
      .find((c) => c.includes("redaction-test") || c.includes("nothing secret here"));
    expect(stored).toBeDefined();

    // Raw secrets must be gone; redaction markers present.
    expect(stored).not.toContain(anthropic);
    expect(stored).not.toContain(awsKey);
    expect(stored).toContain("[REDACTED:anthropic_key]");
    expect(stored).toContain("[REDACTED:aws_access_key]");
    // Non-secret content is preserved untouched.
    expect(stored).toContain("nothing secret here");
  });
});
