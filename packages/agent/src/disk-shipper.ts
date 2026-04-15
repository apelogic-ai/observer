/**
 * Disk shipper — writes normalized TraceEntry JSONL to local filesystem.
 *
 * Output: {outputDir}/{YYYY-MM-DD}/{agent}/{batchId}.jsonl
 * Each line is a parsed, disclosure-filtered, secret-redacted TraceEntry.
 *
 * Implements the same (batch: ShippedBatch) => Promise<void> interface
 * as the HTTP shipper, so it plugs into the existing Shipper callback.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeEntry } from "./parsers/claude";
import { parseCodexEntry } from "./parsers/codex";
import { applyDisclosure, type TraceEntry, type DisclosureLevel } from "./types";
import { redactSecrets } from "./security/scanner";
import type { ShippedBatch } from "./shipper";

export interface DiskShipperConfig {
  outputDir: string;
  disclosure: DisclosureLevel;
  redactSecrets?: boolean;
}

function parseEntry(
  raw: Record<string, unknown>,
  agent: string,
  sessionId: string,
  meta: { developer: string; machine: string; project: string },
): TraceEntry | null {
  if (agent === "claude_code") {
    return parseClaudeEntry(raw, sessionId, meta);
  }
  if (agent === "codex") {
    return parseCodexEntry(raw, sessionId, meta);
  }
  // Cursor entries are already extracted from SQLite — no JSONL parser available
  return null;
}

/**
 * Create a ship function that writes normalized entries to disk.
 */
export function createDiskShipper(
  config: DiskShipperConfig,
): (batch: ShippedBatch) => Promise<void> {
  return async (batch: ShippedBatch): Promise<void> => {
    const date = new Date(batch.shippedAt);
    const dateStr = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("-");

    const normalized: string[] = [];

    for (const entryStr of batch.entries) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(entryStr);
      } catch {
        continue;
      }

      const entry = parseEntry(raw, batch.agent, batch.batchId, {
        developer: batch.developer,
        machine: batch.machine,
        project: batch.project,
      });
      if (!entry) continue;

      // Apply disclosure level
      let filtered = applyDisclosure(entry, config.disclosure);

      // Redact secrets in string fields
      if (config.redactSecrets) {
        const json = JSON.stringify(filtered);
        const redacted = redactSecrets(json);
        filtered = JSON.parse(redacted) as TraceEntry;
      }

      normalized.push(JSON.stringify(filtered));
    }

    if (normalized.length === 0) return;

    const dir = join(config.outputDir, dateStr, batch.agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${batch.batchId}.jsonl`), normalized.join("\n") + "\n");
  };
}
