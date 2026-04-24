#!/usr/bin/env bun
/**
 * Ingestor server entry point.
 */

import { createIngestor } from "./server";

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

console.log(`Observer API starting...`);
console.log(`  Port: ${port}`);
console.log(`  Data: ${dataDir}`);
console.log(`  API keys: ${apiKeys.length} configured${usingDevKey ? " (DEV FALLBACK — do not use in production)" : ""}`);
console.log();

createIngestor({ port, dataDir, apiKeys }).then(() => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`  POST /api/ingest  — receive batches`);
  console.log(`  GET  /health      — health check`);
});
