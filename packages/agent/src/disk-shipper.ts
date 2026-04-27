/**
 * Disk shipper — writes normalized TraceEntry JSONL to local filesystem.
 *
 * Output: {outputDir}/{YYYY-MM-DD}/{agent}/{batchId}.jsonl
 * Each line is a parsed, disclosure-filtered, secret-redacted TraceEntry.
 *
 * Implements the same (batch: ShippedBatch) => Promise<void> interface
 * as the HTTP shipper, so it plugs into the existing Shipper callback.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseClaudeEntries } from "./parsers/claude";
import { parseCodexEntry } from "./parsers/codex";
import { parseCursorDb } from "./parsers/cursor";
import { applyDisclosure, type TraceEntry, type DisclosureLevel } from "./types";
import { redactSecrets } from "./security/scanner";
import type { ShippedBatch } from "./shipper";

export interface DiskShipperConfig {
  outputDir: string;
  disclosure: DisclosureLevel;
  redactSecrets?: boolean;
  useLocalTime?: boolean;
}

function parseEntries(
  raw: Record<string, unknown>,
  agent: string,
  sessionId: string,
  meta: { developer: string; machine: string; project: string },
): TraceEntry[] {
  if (agent === "claude_code") {
    return parseClaudeEntries(raw, sessionId, meta);
  }
  if (agent === "codex") {
    const entry = parseCodexEntry(raw, sessionId, meta);
    return entry ? [entry] : [];
  }
  // Cursor entries are already extracted from SQLite — no JSONL parser available
  return [];
}

/**
 * Extract a YYYY-MM-DD date string from a timestamp.
 * Uses UTC by default; local time if configured.
 * Returns null if the timestamp is empty or unparseable.
 */
function toDateStr(timestamp: string, useLocalTime: boolean): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return null;
  if (useLocalTime) {
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Get the date string for an entry, falling back to a file's mtime.
 */
function entryDateStr(timestamp: string, useLocalTime: boolean, fallbackDate: string): string {
  return toDateStr(timestamp, useLocalTime) ?? fallbackDate;
}

/**
 * Create a ship function that writes normalized entries to disk.
 * Entries are partitioned by their own timestamp (UTC by default),
 * not by when the scan ran.
 */
export function createDiskShipper(
  config: DiskShipperConfig,
): (batch: ShippedBatch) => Promise<void> {
  return async (batch: ShippedBatch): Promise<void> => {
    // Fallback date: source file's mtime (for entries with no timestamp)
    let fallbackDate: string;
    try {
      const mtime = statSync(batch.sourceFile).mtime;
      fallbackDate = toDateStr(mtime.toISOString(), !!config.useLocalTime) ?? new Date().toISOString().slice(0, 10);
    } catch {
      fallbackDate = new Date().toISOString().slice(0, 10);
    }

    // Group normalized entries by date
    const byDate = new Map<string, string[]>();

    for (const entryStr of batch.entries) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(entryStr);
      } catch {
        continue;
      }

      const entries = parseEntries(raw, batch.agent, batch.batchId, {
        developer: batch.developer,
        machine: batch.machine,
        project: batch.project,
      });

      for (let filtered of entries) {
        filtered = applyDisclosure(filtered, config.disclosure);

        if (config.redactSecrets) {
          const json = JSON.stringify(filtered);
          const redacted = redactSecrets(json);
          filtered = JSON.parse(redacted) as TraceEntry;
        }

        const dateKey = entryDateStr(filtered.timestamp, !!config.useLocalTime, fallbackDate);
        const bucket = byDate.get(dateKey) ?? [];
        bucket.push(JSON.stringify(filtered));
        byDate.set(dateKey, bucket);
      }
    }

    // Write one file per date partition
    for (const [dateKey, lines] of byDate) {
      const dir = join(config.outputDir, dateKey, batch.agent);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${batch.batchId}.jsonl`), lines.join("\n") + "\n");
    }
  };
}

export interface CursorShipConfig {
  outputDir: string;
  disclosure: DisclosureLevel;
  redactSecrets?: boolean;
  useLocalTime?: boolean;
  developer: string;
  machine: string;
  /** Project label derived from the Cursor workspace.json. Required —
   *  without it the dashboard's per-project filter drops every Cursor
   *  entry (Cursor's state.vscdb has no project field of its own). */
  project: string;
  stateDir: string;
}

/**
 * Load the set of already-shipped entry IDs for a Cursor database.
 */
function loadShippedIds(stateDir: string, dbPath: string): Set<string> {
  const key = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  const file = join(stateDir, `shipped-cursor-ide-${key}.json`);
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf-8")) as string[];
      return new Set(data);
    } catch { return new Set(); }
  }
  return new Set();
}

/**
 * Persist the set of shipped entry IDs.
 */
function saveShippedIds(stateDir: string, dbPath: string, ids: Set<string>): void {
  const key = createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `shipped-cursor-ide-${key}.json`), JSON.stringify([...ids]));
}

/**
 * Parse a Cursor SQLite database, apply disclosure + redaction,
 * and write only NEW (not previously shipped) entries to disk.
 *
 * Tracks shipped entry IDs in a sidecar file so multi-day sessions
 * are handled incrementally — new bubbles within existing sessions
 * are picked up without re-exporting the entire database.
 *
 * Returns the number of new entries written.
 */
export function shipCursorEntries(dbPath: string, config: CursorShipConfig): number {
  const allEntries = parseCursorDb(dbPath, {
    developer: config.developer,
    machine: config.machine,
    project: config.project,
  });

  if (allEntries.length === 0) return 0;

  // Filter to only new entries
  const shippedIds = loadShippedIds(config.stateDir, dbPath);
  const newEntries = allEntries.filter((e) => !shippedIds.has(e.id));

  if (newEntries.length === 0) return 0;

  // Fallback: db file's mtime
  let fallbackDate: string;
  try {
    const mtime = statSync(dbPath).mtime;
    fallbackDate = toDateStr(mtime.toISOString(), !!config.useLocalTime) ?? new Date().toISOString().slice(0, 10);
  } catch {
    fallbackDate = new Date().toISOString().slice(0, 10);
  }

  // Group by entry timestamp date
  const byDate = new Map<string, string[]>();
  for (let entry of newEntries) {
    entry = applyDisclosure(entry, config.disclosure);
    if (config.redactSecrets) {
      const json = JSON.stringify(entry);
      const redacted = redactSecrets(json);
      entry = JSON.parse(redacted) as TraceEntry;
    }
    const dateKey = entryDateStr(entry.timestamp, !!config.useLocalTime, fallbackDate);
    const bucket = byDate.get(dateKey) ?? [];
    bucket.push(JSON.stringify(entry));
    byDate.set(dateKey, bucket);
  }

  if (byDate.size === 0) return 0;

  // Write one file per date partition
  for (const [dateKey, lines] of byDate) {
    const batchId = createHash("sha256")
      .update(`${dbPath}:${shippedIds.size}:${lines.length}:${dateKey}`)
      .digest("hex")
      .slice(0, 16);

    const dir = join(config.outputDir, dateKey, "cursor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${batchId}.jsonl`), lines.join("\n") + "\n");
  }

  // Mark all entries (old + new) as shipped
  for (const entry of allEntries) shippedIds.add(entry.id);
  saveShippedIds(config.stateDir, dbPath, shippedIds);

  let total = 0;
  for (const lines of byDate.values()) total += lines.length;
  return total;
}
