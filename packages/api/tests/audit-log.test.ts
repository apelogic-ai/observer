import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIngestor } from "../src/server";
import type { Server } from "node:http";

// Security audit trail (§3 logging / §5): authentication events and
// authorization failures must be recorded centrally, with identities hashed
// (never raw). These are distinct from the per-request access log and are
// tagged audit:true so a SIEM can route them to long (1-year) retention.
describe("Ingestor server — security audit log", () => {
  const PORT = 19890;
  let server: Server;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "observer-audit-"));
    server = await createIngestor({
      port: PORT,
      dataDir,
      apiKeys: { key_test_valid: "alice@acme.com" },
    });
  });

  afterAll(() => server?.close());

  async function captureAudit(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => { lines.push(String(line)); };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((e): e is Record<string, unknown> => !!e && e.event === "audit");
  }

  function body(developer: string) {
    return JSON.stringify({
      developer, machine: "m", agent: "claude_code", project: "audit",
      sourceFile: "f", shippedAt: "2026-06-09T00:00:00Z", entries: ["{}"],
    });
  }

  it("records a hashed auth_success on valid credentials", async () => {
    const events = await captureAudit(async () => {
      await fetch(`http://localhost:${PORT}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer key_test_valid" },
        body: body("alice@acme.com"),
      });
    });
    const success = events.find((e) => e.category === "auth_success");
    expect(success).toBeDefined();
    expect(success).toMatchObject({ event: "audit", audit: true, method: "apikey" });
    expect(success!.developerHashPrefix).toEqual(expect.any(String));
    // Never log the raw identity or the key.
    expect(JSON.stringify(success)).not.toContain("alice@acme.com");
    expect(JSON.stringify(success)).not.toContain("key_test_valid");
  });

  it("records an auth_failure when no credentials are supplied", async () => {
    const events = await captureAudit(async () => {
      await fetch(`http://localhost:${PORT}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body("alice@acme.com"),
      });
    });
    const failure = events.find((e) => e.category === "auth_failure");
    expect(failure).toMatchObject({ event: "audit", audit: true, reason: "no_credentials" });
  });

  it("records an authz_failure on developer/tenant mismatch", async () => {
    const events = await captureAudit(async () => {
      await fetch(`http://localhost:${PORT}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer key_test_valid" },
        body: body("someone-else@acme.com"),
      });
    });
    const authz = events.find((e) => e.category === "authz_failure");
    expect(authz).toMatchObject({ event: "audit", audit: true, reason: "developer_mismatch" });
    expect(JSON.stringify(authz)).not.toContain("alice@acme.com");
  });
});
