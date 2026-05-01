/**
 * Shipper — offset-based idempotent trace shipping.
 *
 * Tracks the last-shipped byte offset per file. On each processFile()
 * call, streams new bytes since that offset, validates each line as JSON,
 * optionally redacts secrets, and ships in chunks (one batch per ~5000
 * entries). Offset only advances after a chunk is successfully shipped,
 * so a mid-stream failure leaves later bytes unread for the next poll.
 *
 * Streaming (vs the old slurp-then-skip-if->200MB approach) means:
 *   - Huge JSONL files are no longer skipped permanently.
 *   - Peak memory stays bounded (one chunk + one batch's entries) instead
 *     of allocating ~2x the file size as strings.
 *   - Partial trailing lines (file being appended to) are held back; offset
 *     only advances to the last complete newline.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { redactSecrets } from "./security/scanner";

export interface ShippedBatch {
  batchId: string;      // deterministic: hash(filePath + offsetStart + offsetEnd + entryCount)
  developer: string;
  machine: string;
  agent: string;
  project: string;
  sourceFile: string;
  shippedAt: string;
  entries: string[];
}

export interface ShipperConfig {
  developer?: string;  // explicit override; defaults to git config user.email
  machine?: string;    // machine identifier; defaults to os.hostname()
  stateDir: string;
  redactSecrets?: boolean;
  /** Max entries per shipped batch. Lower → smaller per-batch memory and
   *  HTTP payloads, more batches per file. Default 5000. */
  maxBatchEntries?: number;
  ship: (batch: ShippedBatch) => Promise<void>;
}

type OffsetMap = Record<string, number>; // fileHash → byte offset

const DEFAULT_MAX_BATCH_ENTRIES = 5000;
const NEWLINE = 0x0a;

function fileHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/**
 * Resolve developer identity. Priority:
 * 1. Explicit config value
 * 2. git config user.email
 * 3. git config user.name
 * 4. OS username
 */
function resolveDeveloper(explicit?: string): string {
  if (explicit) return explicit;
  try {
    const email = execSync("git config --global user.email", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (email) return email;
  } catch { /* no git or no config */ }
  try {
    const name = execSync("git config --global user.name", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (name) return name;
  } catch { /* no git or no config */ }
  return process.env.USER ?? process.env.USERNAME ?? "unknown";
}

export class Shipper {
  private config: ShipperConfig;
  private offsets: OffsetMap;
  private offsetFile: string;
  private maxBatchEntries: number;
  readonly developer: string;
  readonly machine: string;

  constructor(config: ShipperConfig) {
    this.config = config;
    this.developer = resolveDeveloper(config.developer);
    this.machine = config.machine ?? hostname();
    this.offsetFile = join(config.stateDir, "shipper-offsets.json");
    this.offsets = this.loadOffsets();
    this.maxBatchEntries = config.maxBatchEntries ?? DEFAULT_MAX_BATCH_ENTRIES;
  }

  private loadOffsets(): OffsetMap {
    if (existsSync(this.offsetFile)) {
      try {
        return JSON.parse(readFileSync(this.offsetFile, "utf-8"));
      } catch {
        return {};
      }
    }
    return {};
  }

  private saveOffsets(): void {
    mkdirSync(this.config.stateDir, { recursive: true });
    writeFileSync(this.offsetFile, JSON.stringify(this.offsets, null, 2));
  }

  private async shipBatch(
    filePath: string,
    agent: string,
    project: string,
    entries: string[],
    offsetStart: number,
    offsetEnd: number,
  ): Promise<boolean> {
    // Deterministic batch ID for ingestor-side dedup; based on the byte
    // range, not entry contents, so re-shipping the same range is idempotent.
    const batchId = createHash("sha256")
      .update(`${filePath}:${offsetStart}:${offsetEnd}:${entries.length}`)
      .digest("hex")
      .slice(0, 16);

    const batch: ShippedBatch = {
      batchId,
      developer: this.developer,
      machine: this.machine,
      agent,
      project,
      sourceFile: filePath,
      shippedAt: new Date().toISOString(),
      entries,
    };

    try {
      await this.config.ship(batch);
      return true;
    } catch (err) {
      // Surface the failure. Earlier this was a bare `catch {}` which made
      // 401s, network errors, and 5xx invisible to the operator —
      // shipBatch returned false, the cursor stalled, and the next poll
      // tried the same window again, forever. Stderr keeps it visible
      // to launchd's StandardErrorPath without pulling in the log module
      // (avoids a circular dep with the test harness).
      const msg = err instanceof Error ? err.message : String(err);
      const trimmed = msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
      // eslint-disable-next-line no-console
      console.error(
        `[shipper] failed to ship batch ${batch.batchId} (${entries.length} entries) from ${filePath}: ${trimmed}`,
      );
      return false;
    }
  }

  /**
   * Stream a trace file from its last-shipped offset, ship in chunks of
   * up to `maxBatchEntries`, and advance the offset after each successful
   * chunk. Returns the number of batches actually shipped.
   *
   * No file size limit: large files are processed line by line. A trailing
   * partial line (file is being appended to mid-poll) is left for the next
   * call — offset only advances to the last full newline.
   */
  async processFile(filePath: string, agent: string, project: string): Promise<number> {
    if (!existsSync(filePath)) return 0;

    const key = fileHash(filePath);
    const startOffset = this.offsets[key] ?? 0;
    const stat = statSync(filePath);
    if (stat.size <= startOffset) return 0;

    const stream = createReadStream(filePath, { start: startOffset });

    // Bytes received from the stream so far. Position relative to startOffset.
    let cumulativeBytes = 0;
    // Buffer carrying any bytes from the most recent chunks that haven't
    // been flushed as a complete line yet. Typed loosely so the per-chunk
    // concat with stream-emitted Buffers (Buffer<ArrayBufferLike>) doesn't
    // fight the alloc(0) seed type (Buffer<ArrayBuffer>).
    let pendingBuf: Buffer = Buffer.alloc(0);
    // Position (relative to startOffset) up through the last \n we've
    // emitted. Offset will be advanced to startOffset + lastSafeBytes.
    let lastSafeBytes = 0;

    let entries: string[] = [];
    let batchStartOffset = startOffset;
    let batchesShipped = 0;
    let aborted = false;

    const tryFlush = async (force: boolean): Promise<boolean> => {
      if (!force && entries.length < this.maxBatchEntries) return true;
      if (entries.length === 0) return true;
      const batchEndOffset = startOffset + lastSafeBytes;
      const ok = await this.shipBatch(
        filePath, agent, project, entries, batchStartOffset, batchEndOffset,
      );
      if (!ok) return false;
      this.offsets[key] = batchEndOffset;
      this.saveOffsets();
      batchStartOffset = batchEndOffset;
      entries = [];
      batchesShipped++;
      return true;
    };

    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      pendingBuf = pendingBuf.length === 0 ? buf : Buffer.concat([pendingBuf, buf]);
      cumulativeBytes += buf.length;

      // Walk pendingBuf looking for newlines; emit each complete line.
      let lineStart = 0;
      let nlIdx: number;
      while ((nlIdx = pendingBuf.indexOf(NEWLINE, lineStart)) !== -1) {
        const line = pendingBuf.subarray(lineStart, nlIdx).toString("utf-8").trim();
        lineStart = nlIdx + 1;
        // Update lastSafeBytes after each complete line.
        lastSafeBytes = cumulativeBytes - (pendingBuf.length - lineStart);

        if (!line) continue;
        try {
          JSON.parse(line);
          const processed = this.config.redactSecrets ? redactSecrets(line) : line;
          entries.push(processed);
        } catch { /* invalid JSON line — skip but still advance past it */ }

        if (entries.length >= this.maxBatchEntries) {
          if (!(await tryFlush(true))) {
            aborted = true;
            break;
          }
        }
      }

      // Drop already-processed bytes from pendingBuf.
      pendingBuf = pendingBuf.subarray(lineStart);

      if (aborted) {
        stream.destroy();
        return batchesShipped;
      }
    }

    // Stream EOF. Flush remaining entries (if any).
    if (entries.length > 0) {
      if (!(await tryFlush(true))) return batchesShipped;
    }

    // If the file ends with a newline we've consumed everything (pendingBuf
    // is empty). If not, pendingBuf holds an incomplete trailing line that
    // we deliberately don't advance past — it'll be re-read on the next
    // poll once it (presumably) completes.
    if (pendingBuf.length === 0 && this.offsets[key] !== stat.size) {
      this.offsets[key] = stat.size;
      this.saveOffsets();
    }

    return batchesShipped;
  }
}
