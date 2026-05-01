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
  trustedKeys?: Record<string, string>;   // fingerprint → PEM public key
  apiKeys?: string[];                      // valid API keys
  /** Max request body size in bytes. Defaults to 8 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Read the request body as a string, capped at `maxBytes`. Rejects with a
 *  "body too large" error once the cap is exceeded so a malicious POST can't
 *  exhaust process memory. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`body too large (>${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
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
  const validApiKeys = new Set(config.apiKeys ?? []);
  const trustedKeys = config.trustedKeys ?? {};
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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
        json(res, 413, { error: String(err) });
        return;
      }

      // --- Authentication ---
      const authHeader = req.headers["authorization"];
      const signature = req.headers["x-observer-signature"] as string | undefined;
      const fingerprint = req.headers["x-observer-key-fingerprint"] as string | undefined;

      let authenticated = false;

      // API key auth
      if (authHeader?.startsWith("Bearer ")) {
        const key = authHeader.slice(7);
        if (validApiKeys.has(key)) {
          authenticated = true;
        }
      }

      // Signature auth
      if (!authenticated && signature && fingerprint) {
        const publicKeyPem = trustedKeys[fingerprint];
        if (!publicKeyPem) {
          json(res, 401, { error: "Unknown key fingerprint" });
          return;
        }
        if (!verifyEd25519(body, signature, publicKeyPem)) {
          json(res, 403, { error: "Invalid signature" });
          return;
        }
        authenticated = true;
      }

      if (!authenticated) {
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
