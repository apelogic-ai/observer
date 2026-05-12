/**
 * Ingestor HTTP server — receives trace batches from observer agents.
 *
 * Authentication (either is sufficient):
 * - Bearer API key (Authorization header)
 * - Ed25519 signature (X-Observer-Signature + X-Observer-Key-Fingerprint headers)
 *
 * On valid auth: stores batch to the lakehouse (Store).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { Store } from "./store";
import type { Storage } from "./storage";

export interface IngestorConfig {
  port: number;
  /** Filesystem data dir. Used to construct a default LocalStorage if no
   *  `storage` is provided. Either `dataDir` or `storage` must be set. */
  dataDir?: string;
  /** Storage backend override. Pass an S3Storage to write to S3 instead of
   *  the local filesystem; pass a custom backend for tests. Wins over
   *  `dataDir` when both are supplied. */
  storage?: Storage;
  /** Ed25519 trust map: fingerprint → { developer, PEM public key }.
   *  The `developer` binds the key to a tenant identity so the
   *  authenticated caller can only write batches for their own
   *  developer (OBS-004, 2026-05 review). */
  trustedKeys?: Record<string, { developer: string; publicKeyPem: string }>;
  /** API key → developer map. Same tenant-binding semantics as
   *  `trustedKeys`: each key authenticates exactly one developer.
   *  A batch whose `developer` field doesn't match the authenticated
   *  developer is rejected (OBS-004). */
  apiKeys?: Record<string, string>;
  /** Max request body size in bytes. Defaults to 32 MiB — sized to accept
   *  Codex `compacted` events that inline the full conversation history,
   *  which routinely cross 8 MiB on long sessions. Override via the
   *  OBSERVER_MAX_BODY_BYTES env var if you need to go higher. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

// Replay-protection knobs (OBS-005). Signed batches must arrive
// within ±5min of server time and carry a nonce not seen in the
// past 10min. The asymmetry — accept-window narrower than
// nonce-cache window — guarantees that a captured POST can't be
// replayed within the accept-window and the cache always covers
// the full acceptance band even under clock skew at the agent.
const REPLAY_WINDOW_SECONDS = 5 * 60;
const NONCE_TTL_MS = 10 * 60 * 1000;
// Hard upper bound on entries kept in the nonce cache. With a
// realistic agent emitting one batch per second, the steady-state
// is ~600 entries (10min × 60); the cap exists so a flood of
// 1-RPS attackers can't OOM the process. Sweep runs when the cap
// is reached; entries past their TTL are evicted.
const NONCE_CACHE_MAX = 100_000;

function sweepNonceCache(cache: Map<string, number>): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of cache) {
    if (expiresAt <= now) cache.delete(nonce);
  }
}


/** Read the request body as a string, capped at `maxBytes`. Rejects with a
 *  "body too large" error once the cap is exceeded so a malicious POST can't
 *  exhaust process memory.
 *
 *  Once the cap is hit we stop accumulating chunks (drop them on the floor)
 *  and pause the stream, but we do NOT destroy the request — the request
 *  and response share a socket, so destroying it would tear down the
 *  response before the 413 could flush. The handler still gets to write a
 *  proper 413; without that, Caddy in front saw an upstream that closed
 *  with no status and turned it into a 502 with an empty body. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        req.pause();
        reject(new Error(`body too large (>${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (overflowed) return;
      reject(err);
    });
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function verifyEd25519(payload: string, signature: string, publicKeyPem: string): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function createIngestor(config: IngestorConfig): Promise<Server> {
  if (!config.storage && !config.dataDir) {
    throw new Error("createIngestor requires either `storage` or `dataDir`");
  }
  const store = new Store(config.storage ?? config.dataDir!);
  // Tenant binding: each credential resolves to exactly one developer.
  // Reject batches whose `developer` field doesn't match the resolved
  // tenant (OBS-004, 2026-05 review).
  const apiKeyToDeveloper = new Map<string, string>(Object.entries(config.apiKeys ?? {}));
  const trustedKeys = config.trustedKeys ?? {};
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // Per-server nonce cache: each createIngestor() gets a fresh map so
  // tests can spin up isolated servers and so a restart drops history.
  // The cost of a fresh map on restart is bounded: every captured POST
  // expires REPLAY_WINDOW_SECONDS after its timestamp, so the post-
  // restart vulnerability window is ≤5min for any in-flight replay.
  const nonceCache = new Map<string, number>();

  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    // Ingest endpoint
    if (req.method === "POST" && req.url === "/api/ingest") {
      let body: string;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (err) {
        // The client may still be uploading bytes after we hit the cap.
        // Sending Connection: close tells Node to drop the socket after
        // this response, so we don't have to drain or contend with
        // leftover data on a keep-alive channel.
        res.writeHead(413, {
          "Content-Type": "application/json",
          "Connection": "close",
        });
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }

      // --- Authentication ---
      // Both auth modes (API key + Ed25519 fingerprint) resolve to a
      // developer identity; the batch's `developer` field must match
      // that identity (OBS-004). authenticatedDeveloper stays null
      // until a credential validates AND resolves a tenant.
      const authHeader = req.headers["authorization"];
      const signature = req.headers["x-observer-signature"] as string | undefined;
      const fingerprint = req.headers["x-observer-key-fingerprint"] as string | undefined;
      const timestampHeader = req.headers["x-observer-timestamp"] as string | undefined;
      const nonceHeader = req.headers["x-observer-nonce"] as string | undefined;

      let authenticatedDeveloper: string | null = null;

      // API key auth
      if (authHeader?.startsWith("Bearer ")) {
        const key = authHeader.slice(7);
        const dev = apiKeyToDeveloper.get(key);
        if (dev) authenticatedDeveloper = dev;
      }

      // Signature auth + replay protection (OBS-005).
      // The signed string is `${timestamp}.${nonce}.${body}`; the
      // timestamp must be within ±5min of server time and the nonce
      // must not have been seen in the past 10min. This binds the
      // signature to a single point in time and a unique submission,
      // so a captured POST can't be replayed against this or any
      // ingestor that shares the trusted-keys list.
      if (authenticatedDeveloper === null && signature && fingerprint) {
        const entry = trustedKeys[fingerprint];
        if (!entry) {
          json(res, 401, { error: "Unknown key fingerprint" });
          return;
        }
        if (!timestampHeader || !nonceHeader) {
          json(res, 400, { error: "Missing X-Observer-Timestamp or X-Observer-Nonce header" });
          return;
        }
        const ts = Number(timestampHeader);
        if (!Number.isFinite(ts)) {
          json(res, 400, { error: "Invalid X-Observer-Timestamp header" });
          return;
        }
        const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
        if (skew > REPLAY_WINDOW_SECONDS) {
          json(res, 401, { error: "Request timestamp outside acceptable window" });
          return;
        }
        if (nonceCache.has(nonceHeader)) {
          json(res, 401, { error: "Nonce already used" });
          return;
        }
        const canonical = `${timestampHeader}.${nonceHeader}.${body}`;
        if (!verifyEd25519(canonical, signature, entry.publicKeyPem)) {
          json(res, 403, { error: "Invalid signature" });
          return;
        }
        // Mark nonce as seen for the replay window. Cleanup happens
        // opportunistically below to keep the cache bounded.
        nonceCache.set(nonceHeader, Date.now() + NONCE_TTL_MS);
        if (nonceCache.size > NONCE_CACHE_MAX) sweepNonceCache(nonceCache);
        authenticatedDeveloper = entry.developer;
      }

      if (authenticatedDeveloper === null) {
        json(res, 401, { error: "Authentication required" });
        return;
      }

      // --- Parse and store ---
      let batch: Record<string, unknown>;
      try {
        batch = JSON.parse(body);
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }

      const entries = batch.entries;
      if (!Array.isArray(entries)) {
        json(res, 400, { error: "Missing entries array" });
        return;
      }

      const batchId = typeof batch.batchId === "string" ? batch.batchId : undefined;
      const developer = String(batch.developer ?? "unknown");

      // Tenant binding: the credential resolves to a developer, and the
      // batch's `developer` must match. Without this, any authenticated
      // caller could pre-claim another developer's batchIds and cause
      // the legitimate batches to be silently dropped as duplicates
      // (OBS-004, 2026-05 review).
      if (developer !== authenticatedDeveloper) {
        json(res, 403, { error: "developer mismatch: batch's developer field does not match the authenticated identity" });
        return;
      }

      // Dedup: if we've already received this batchId, return 200 (idempotent)
      if (batchId && (await store.isDuplicate(batchId, developer))) {
        json(res, 200, { status: "ok", duplicate: true, entryCount: 0 });
        return;
      }

      const result = await store.saveBatch({
        batchId,
        developer,
        machine: String(batch.machine ?? "unknown"),
        agent: String(batch.agent ?? "unknown"),
        project: String(batch.project ?? "unknown"),
        sourceFile: String(batch.sourceFile ?? ""),
        shippedAt: String(batch.shippedAt ?? ""),
        receivedAt: new Date().toISOString(),
        entries: entries.map(String),
      });

      json(res, 200, { status: "ok", entryCount: result.entryCount });
      return;
    }

    // 404
    json(res, 404, { error: "Not found" });
  });

  return new Promise((resolve) => {
    server.listen(config.port, () => resolve(server));
  });
}
