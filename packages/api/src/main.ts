#!/usr/bin/env bun
/**
 * Ingestor server entry point.
 */

import { createIngestor } from "./server";

const port = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "") ||
  parseInt(process.argv[process.argv.indexOf("--port") + 1] ?? "") || 19900;
const dataDir = process.argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1] ??
  process.argv[process.argv.indexOf("--data-dir") + 1] ?? `${process.env.HOME}/.observer/lakehouse`;

// For local testing, accept any API key
const apiKeys = process.env.OBSERVER_API_KEYS?.split(",") ?? ["key_local_dev"];

console.log(`Observer API starting...`);
console.log(`  Port: ${port}`);
console.log(`  Data: ${dataDir}`);
console.log(`  API keys: ${apiKeys.length} configured`);
console.log();

createIngestor({ port, dataDir, apiKeys }).then(() => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`  POST /api/ingest  — receive batches`);
  console.log(`  GET  /health      — health check`);
});
