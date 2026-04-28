import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  readCursorAuth,
  readCursorUsageSidecar,
  writeCursorUsageSidecar,
  sidecarPath,
} from "../src/cursor-api";

/** Build a syntactically valid (but unsigned, with whatever payload we want) JWT.
 *  We never verify signatures here — the module only inspects the payload. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function makeFakeStateDb(payload: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "observer-cursor-"));
  const dbPath = join(dir, "state.vscdb");
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  if (payload !== null) {
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)")
      .run("cursorAuth/accessToken", makeJwt(payload));
  }
  db.close();
  return dbPath;
}

// ── readCursorAuth ─────────────────────────────────────────────────

describe("readCursorAuth", () => {
  it("returns null when the DB doesn't exist", () => {
    expect(readCursorAuth("/nonexistent/path/state.vscdb")).toBeNull();
  });

  it("returns null when the DB has no auth row", () => {
    expect(readCursorAuth(makeFakeStateDb(null))).toBeNull();
  });

  it("returns null when the JWT has no sub claim", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const dbPath = makeFakeStateDb({ exp: future });  // no `sub`
    expect(readCursorAuth(dbPath)).toBeNull();
  });

  it("returns null when the JWT is expired", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const dbPath = makeFakeStateDb({ sub: "user_x", exp: past });
    expect(readCursorAuth(dbPath)).toBeNull();
  });

  it("decodes sub and builds the cookie when the JWT is valid", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const dbPath = makeFakeStateDb({ sub: "user_abc123", exp: future });
    const auth = readCursorAuth(dbPath);
    expect(auth).not.toBeNull();
    expect(auth!.sub).toBe("user_abc123");
    // Cookie is `<encoded sub>%3A%3A<jwt>`. The "::" must be URL-encoded.
    expect(auth!.cookie).toContain("%3A%3A");
    expect(auth!.cookie.startsWith("user_abc123%3A%3A")).toBe(true);
  });

  it("URL-encodes the sub when it contains special characters", () => {
    // Real Google OAuth subs contain '|' (e.g. "google-oauth2|user_…").
    const future = Math.floor(Date.now() / 1000) + 3600;
    const dbPath = makeFakeStateDb({ sub: "google-oauth2|user_X", exp: future });
    const auth = readCursorAuth(dbPath)!;
    expect(auth.cookie.startsWith("google-oauth2%7Cuser_X%3A%3A")).toBe(true);
  });
});

// ── sidecar I/O ────────────────────────────────────────────────────

describe("cursor usage sidecar", () => {
  let outputDir: string;
  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), "observer-sidecar-"));
  });

  it("returns null when no sidecar exists", () => {
    expect(readCursorUsageSidecar(outputDir, "2026-04-27")).toBeNull();
  });

  it("writes and reads back the same totals", () => {
    const totals = {
      input: 12345, output: 678, cacheRead: 9001, cacheCreation: 0, reasoning: 0,
      costCents: 4.2, modelIntents: ["default"],
    };
    writeCursorUsageSidecar(outputDir, "2026-04-27", totals);
    const read = readCursorUsageSidecar(outputDir, "2026-04-27");
    expect(read).not.toBeNull();
    expect(read!.v).toBe(1);
    expect(read!.date).toBe("2026-04-27");
    expect(read!.totals).toEqual(totals);
    // fetchedAt should be a recent ISO string
    expect(Date.now() - Date.parse(read!.fetchedAt)).toBeLessThan(5000);
  });

  it("returns null when the file isn't valid JSON", () => {
    const path = sidecarPath(outputDir, "2026-04-27");
    require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true });
    require("node:fs").writeFileSync(path, "not json {");
    expect(readCursorUsageSidecar(outputDir, "2026-04-27")).toBeNull();
  });

  it("returns null when the schema version doesn't match", () => {
    const path = sidecarPath(outputDir, "2026-04-27");
    require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true });
    require("node:fs").writeFileSync(path, JSON.stringify({ v: 99, date: "2026-04-27" }));
    expect(readCursorUsageSidecar(outputDir, "2026-04-27")).toBeNull();
  });
});
