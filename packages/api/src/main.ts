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

// OBSERVER_API_KEYS is required for any non-development environment. The
// dev fallback is a single fixed key, clearly flagged in the startup log.
const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === undefined;
const rawKeys = process.env.OBSERVER_API_KEYS?.split(",").map((k) => k.trim()).filter(Boolean) ?? [];
if (rawKeys.length === 0 && !isDev) {
  console.error("Refusing to start: OBSERVER_API_KEYS is not set.");
  console.error("Set NODE_ENV=development to use the local dev key, or provide real keys.");
  process.exit(1);
}
const apiKeys = rawKeys.length > 0 ? rawKeys : ["key_local_dev"];
const usingDevKey = rawKeys.length === 0;

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

console.log(`Observer API starting...`);
console.log(`  Port:    ${port}`);
console.log(`  Storage: ${storageDescription}`);
console.log(`  API keys: ${apiKeys.length} configured${usingDevKey ? " (DEV FALLBACK — do not use in production)" : ""}`);
console.log();

createIngestor({ port, dataDir, storage, apiKeys }).then(() => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`  POST /api/ingest  — receive batches`);
  console.log(`  GET  /health      — health check`);
});
