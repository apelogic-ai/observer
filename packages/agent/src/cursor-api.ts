/**
 * Cursor usage API — fetch real consumed-token totals via Cursor's
 * undocumented dashboard endpoints.
 *
 * Cursor doesn't write consumed token counts to its local SQLite
 * (verified: every `tokenCount.inputTokens` field is 0 and per-composer
 * `usageData` is `{}`). The numbers exist only on Cursor's servers, but
 * the local app stores a JWT we can use to call the same endpoints the
 * web dashboard hits — same approach used by every community usage
 * tracker (cursor-credits, cursor-stats, tokscale, etc.).
 *
 * Caveats:
 * - The JWT in `state.vscdb` is account-equivalent. Read on demand,
 *   keep in memory, never log, never persist outside of the file we
 *   read it from.
 * - The endpoint is undocumented; Cursor can move/break it any time.
 *   Every call here is best-effort with silent failure.
 * - Free-tier API only returns date-range aggregates — no per-session
 *   attribution. We bucket per day and write a sidecar that the
 *   dashboard treats as a summary row, not as session-level data.
 */
/* eslint-disable no-console */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** Where Cursor stores its global SQLite on each platform. */
function defaultCursorStateDb(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
    default:
      return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
  }
}

export interface CursorAuth {
  jwt: string;
  sub: string;
  /** Pre-built cookie value (`<sub>::<jwt>` URL-encoded) for the
   *  `WorkosCursorSessionToken` cookie the API expects. */
  cookie: string;
}

/**
 * Read Cursor's local auth. Returns null when the DB is missing, the
 * row doesn't exist, the JWT is malformed, or the token is expired.
 *
 * The JWT and cookie are kept in the returned object only — never
 * logged, never written elsewhere by this module.
 */
export function readCursorAuth(dbPath?: string): CursorAuth | null {
  const path = dbPath ?? defaultCursorStateDb();
  if (!existsSync(path)) return null;

  let jwt: string | null = null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query<{ value: string }, []>(
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
      ).get();
      jwt = row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;  // DB locked, schema mismatch, etc.
  }
  if (!jwt) return null;

  const sub = decodeJwtSub(jwt);
  if (!sub) return null;

  // Reject tokens already past their `exp`. Cursor refreshes on launch,
  // but stale ones cause 401s we'd silently log; better to skip up front.
  if (isJwtExpired(jwt)) return null;

  return {
    jwt,
    sub,
    cookie: `${encodeURIComponent(sub)}%3A%3A${jwt}`,
  };
}

function decodeJwtSub(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const sub = payload.sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

function isJwtExpired(jwt: string): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return true;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: number };
    if (typeof payload.exp !== "number") return false;  // no exp claim → assume valid
    return Date.now() / 1000 >= payload.exp;
  } catch {
    return true;
  }
}

function base64UrlDecode(s: string): string {
  // base64url → base64
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64").toString("utf-8");
}

// ── API call ──────────────────────────────────────────────────────

export interface CursorUsageTotals {
  /** Sum of input tokens across all model intents in the date range. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Cursor's API doesn't separate reasoning tokens; always 0 here. */
  reasoning: number;
  /** Approximate cost in cents for the date range. */
  costCents: number;
  /** Distinct model intents that contributed (e.g., "default", "auto"). */
  modelIntents: string[];
}

interface AggregatedUsageResponse {
  aggregations?: Array<{
    modelIntent?: string;
    inputTokens?: string | number;
    outputTokens?: string | number;
    cacheReadTokens?: string | number;
    cacheWriteTokens?: string | number;
    totalCents?: number;
  }>;
  totalInputTokens?: string | number;
  totalOutputTokens?: string | number;
  totalCacheReadTokens?: string | number;
  totalCacheWriteTokens?: string | number;
  totalCostCents?: number;
}

const API_HOST = "https://cursor.com";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch aggregated usage for an arbitrary [startMs, endMs] range.
 * Returns null on any error (network, 401, schema mismatch).
 */
export async function fetchAggregatedUsage(
  auth: CursorAuth,
  startMs: number,
  endMs: number,
): Promise<CursorUsageTotals | null> {
  const url = `${API_HOST}/api/dashboard/get-aggregated-usage-events`;
  const body = JSON.stringify({ startDate: startMs, endDate: endMs, teamId: null, userId: null, kind: null });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        // The cookie carries auth; Origin/Referer pass Cursor's CSRF
        // origin check on state-changing requests.
        Cookie: `WorkosCursorSessionToken=${auth.cookie}`,
        "Content-Type": "application/json",
        Origin: API_HOST,
        Referer: `${API_HOST}/dashboard`,
        "User-Agent": "observer-agent",
      },
      body,
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return null;

  let data: AggregatedUsageResponse;
  try {
    data = (await res.json()) as AggregatedUsageResponse;
  } catch {
    return null;
  }

  // Cursor returns numbers as strings ("186481"). Normalize with Number().
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(n) ? n : 0;
  };

  const intents = new Set<string>();
  for (const agg of data.aggregations ?? []) {
    if (agg.modelIntent) intents.add(agg.modelIntent);
  }

  return {
    input: num(data.totalInputTokens),
    output: num(data.totalOutputTokens),
    cacheRead: num(data.totalCacheReadTokens),
    cacheCreation: num(data.totalCacheWriteTokens),
    reasoning: 0,
    costCents: typeof data.totalCostCents === "number" ? data.totalCostCents : 0,
    modelIntents: [...intents],
  };
}

// ── Sidecar I/O ───────────────────────────────────────────────────

export interface CursorUsageSidecar {
  /** Schema marker. */
  v: 1;
  /** YYYY-MM-DD this file represents. */
  date: string;
  /** ISO timestamp the API was hit. */
  fetchedAt: string;
  totals: CursorUsageTotals;
}

const SIDECAR_FILENAME = "_usage.json";

/** Resolve `<outputDir>/<date>/cursor/_usage.json`. */
export function sidecarPath(outputDir: string, date: string): string {
  return join(outputDir, date, "cursor", SIDECAR_FILENAME);
}

export function readCursorUsageSidecar(outputDir: string, date: string): CursorUsageSidecar | null {
  const path = sidecarPath(outputDir, date);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (data.v !== 1 || typeof data.date !== "string" || typeof data.fetchedAt !== "string") return null;
    return data as unknown as CursorUsageSidecar;
  } catch {
    return null;
  }
}

export function writeCursorUsageSidecar(
  outputDir: string,
  date: string,
  totals: CursorUsageTotals,
): void {
  const path = sidecarPath(outputDir, date);
  mkdirSync(join(outputDir, date, "cursor"), { recursive: true });
  const payload: CursorUsageSidecar = {
    v: 1,
    date,
    fetchedAt: new Date().toISOString(),
    totals,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

// ── High-level orchestration ──────────────────────────────────────

/** Day boundaries in UTC for a YYYY-MM-DD string. */
function dayBoundsUtc(date: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${date}T00:00:00Z`);
  // 23:59:59.999 — Cursor's API treats endDate as inclusive in our probes.
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1;
  return { startMs, endMs };
}

export interface FetchAndWriteResult {
  written: boolean;
  /** Why we skipped, when we did. */
  reason?: "no-auth" | "no-data" | "fetch-failed" | "stale-skipped";
}

/**
 * Fetch one day's usage and write the sidecar.
 * Pass `force=false` to skip refetching when the existing sidecar was
 * fetched in the last `staleAfterMs` (default 5 min).
 */
export async function fetchAndWriteDailySidecar(
  outputDir: string,
  date: string,
  opts: { force?: boolean; staleAfterMs?: number; auth?: CursorAuth | null } = {},
): Promise<FetchAndWriteResult> {
  const auth = opts.auth ?? readCursorAuth();
  if (!auth) return { written: false, reason: "no-auth" };

  if (!opts.force) {
    const existing = readCursorUsageSidecar(outputDir, date);
    if (existing) {
      const ageMs = Date.now() - Date.parse(existing.fetchedAt);
      if (ageMs < (opts.staleAfterMs ?? 5 * 60 * 1000)) {
        return { written: false, reason: "stale-skipped" };
      }
    }
  }

  const { startMs, endMs } = dayBoundsUtc(date);
  const totals = await fetchAggregatedUsage(auth, startMs, endMs);
  if (!totals) return { written: false, reason: "fetch-failed" };

  // No-op: don't pollute the dashboard with empty days.
  if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0) {
    return { written: false, reason: "no-data" };
  }

  writeCursorUsageSidecar(outputDir, date, totals);
  return { written: true };
}
