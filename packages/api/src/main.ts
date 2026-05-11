#!/usr/bin/env bun
/**
 * Ingestor server entry point.
 *
 * Storage backend selection:
 *   OBSERVER_STORAGE=fs    → local filesystem at --data-dir (default)
 *   OBSERVER_STORAGE=s3    → S3 bucket from OBSERVER_S3_BUCKET
 *
 * S3 env knobs (used when OBSERVER_STORAGE=s3):
 *   OBSERVER_S3_BUCKET      required — bucket name
 *   OBSERVER_S3_REGION      optional — defaults to AWS_REGION or us-east-1
 *   OBSERVER_S3_ENDPOINT    optional — override (minio, R2, LocalStack)
 *
 * AWS credentials follow the SDK's standard chain (env, profile, IRSA,
 * EC2 instance role, etc.); the ingestor doesn't read them directly.
 */

import { createIngestor } from "./server";
import { LocalStorage, S3Storage } from "./storage";
import type { Storage } from "./storage";

const port = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "") ||
  parseInt(process.argv[process.argv.indexOf("--port") + 1] ?? "") || 19900;
const dataDir = process.argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1] ??
  process.argv[process.argv.indexOf("--data-dir") + 1] ?? `${process.env.HOME}/.observer/lakehouse`;

// OBSERVER_API_KEYS is required. No NODE_ENV fallback — the previous
// fallback to a hardcoded "key_local_dev" Bearer token was reachable
// from any deployment that didn't explicitly set NODE_ENV
// (OBS-006, 2026-05 review): the Dockerfile didn't set it, only
// docker-compose.yml did, so bare `docker run` or a misconfigured
// Kubernetes pod ended up authenticating any request with a
// publicly-known key.
//
// Format: each entry is `<developer>:<key>`, e.g.
//   OBSERVER_API_KEYS=alice:key_abc,bob:key_def
// The developer prefix binds the key to a tenant identity so a
// caller can't claim other developers' batches (OBS-004).
const rawKeys = process.env.OBSERVER_API_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
if (rawKeys.length === 0) {
  console.error("Refusing to start: OBSERVER_API_KEYS is not set.");
  console.error("Format: <developer>:<key>,<developer>:<key>");
  console.error('Example: OBSERVER_API_KEYS="alice:key_abc,bob:key_def"');
  process.exit(1);
}
const apiKeys = new Map<string, string>();   // key → developer
for (const entry of rawKeys) {
  const colon = entry.indexOf(":");
  if (colon <= 0 || colon === entry.length - 1) {
    console.error(`Refusing to start: OBSERVER_API_KEYS entry "${entry}" is missing a developer prefix.`);
    console.error("Format: <developer>:<key> per entry. Each key must be bound to a single developer (OBS-004).");
    process.exit(1);
  }
  const developer = entry.slice(0, colon).trim();
  const key = entry.slice(colon + 1).trim();
  if (apiKeys.has(key)) {
    console.error(`Refusing to start: API key listed twice (developers "${apiKeys.get(key)}" and "${developer}").`);
    process.exit(1);
  }
  apiKeys.set(key, developer);
}

// Storage backend
const storageKind = (process.env.OBSERVER_STORAGE ?? "fs").toLowerCase();
let storage: Storage;
let storageDescription: string;
if (storageKind === "s3") {
  const bucket = process.env.OBSERVER_S3_BUCKET;
  if (!bucket) {
    console.error("Refusing to start: OBSERVER_STORAGE=s3 requires OBSERVER_S3_BUCKET.");
    process.exit(1);
  }
  storage = S3Storage.fromOpts(bucket, {
    region: process.env.OBSERVER_S3_REGION,
    endpoint: process.env.OBSERVER_S3_ENDPOINT,
  });
  storageDescription = `s3://${bucket} (${process.env.OBSERVER_S3_REGION ?? process.env.AWS_REGION ?? "us-east-1"}${process.env.OBSERVER_S3_ENDPOINT ? `, endpoint=${process.env.OBSERVER_S3_ENDPOINT}` : ""})`;
} else if (storageKind === "fs") {
  storage = new LocalStorage(dataDir);
  storageDescription = `fs:${dataDir}`;
} else {
  console.error(`Refusing to start: unknown OBSERVER_STORAGE=${storageKind} (expected "fs" or "s3").`);
  process.exit(1);
}

// OBSERVER_MAX_BODY_BYTES — operator override for the request body cap.
// The default in createIngestor (32 MiB) accommodates Codex `compacted`
// events; bump higher when sessions grow larger payloads than that.
let maxBodyBytes: number | undefined;
const rawMaxBody = process.env.OBSERVER_MAX_BODY_BYTES;
if (rawMaxBody) {
  const parsed = parseInt(rawMaxBody, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Refusing to start: OBSERVER_MAX_BODY_BYTES="${rawMaxBody}" is not a positive integer.`);
    process.exit(1);
  }
  maxBodyBytes = parsed;
}

console.log(`Observer API starting...`);
console.log(`  Port:    ${port}`);
console.log(`  Storage: ${storageDescription}`);
console.log(`  API keys: ${apiKeys.size} configured (bound to ${new Set(apiKeys.values()).size} developer${new Set(apiKeys.values()).size === 1 ? "" : "s"})`);
if (maxBodyBytes !== undefined) {
  console.log(`  Max body: ${maxBodyBytes} bytes (override)`);
}
console.log();

createIngestor({
  port, dataDir, storage,
  apiKeys: Object.fromEntries(apiKeys),
  maxBodyBytes,
}).then(() => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`  POST /api/ingest  — receive batches`);
  console.log(`  GET  /health      — health check`);
});
