/**
 * Shipper — offset-based idempotent trace shipping.
 *
 * Tracks the last-shipped byte offset per file. On each processFile()
 * call, reads only new lines, optionally redacts secrets, and calls
 * the ship callback with a batch of raw (redacted) JSONL lines.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { redactSecrets } from "./security/scanner";

export interface ShippedBatch {
  batchId: string;      // deterministic: hash(filePath + offset + entryCount)
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
  ship: (batch: ShippedBatch) => Promise<void>;
}

type OffsetMap = Record<string, number>; // fileHash → byte offset

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
  readonly developer: string;
  readonly machine: string;

  constructor(config: ShipperConfig) {
    this.config = config;
    this.developer = resolveDeveloper(config.developer);
    this.machine = config.machine ?? hostname();
    this.offsetFile = join(config.stateDir, "shipper-offsets.json");
    this.offsets = this.loadOffsets();
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

  /**
   * Process a trace file — read new lines since last offset, redact
   * secrets if configured, ship the batch, and advance offset only
   * on successful shipment.
   */
  async processFile(filePath: string, agent: string, project: string): Promise<boolean> {
    if (!existsSync(filePath)) return false;

    const key = fileHash(filePath);
    const offset = this.offsets[key] ?? 0;
    const stat = statSync(filePath);

    if (stat.size <= offset) return false; // nothing new

    // Skip files larger than 200MB to avoid V8 string length limit
    const MAX_FILE_SIZE = 200 * 1024 * 1024;
    if (stat.size > MAX_FILE_SIZE) {
      console.log(`  [skip] ${filePath}: ${(stat.size / 1024 / 1024).toFixed(0)}MB exceeds 200MB limit`);
      this.offsets[key] = stat.size;
      this.saveOffsets();
      return false;
    }

    // Read from offset to end
    const content = readFileSync(filePath, "utf-8");
    const newContent = content.slice(offset);
    const lines = newContent.split("\n").filter((l) => l.trim());

    if (lines.length === 0) {
      this.offsets[key] = stat.size;
      this.saveOffsets();
      return false;
    }

    // Validate JSON + optionally redact
    const validEntries: string[] = [];
    for (const line of lines) {
      try {
        JSON.parse(line); // validate
        const processed = this.config.redactSecrets
          ? redactSecrets(line)
          : line;
        validEntries.push(processed);
      } catch {
        // Skip invalid JSON lines
      }
    }

    if (validEntries.length === 0) {
      this.offsets[key] = stat.size;
      this.saveOffsets();
      return false;
    }

    // Deterministic batch ID for ingestor-side dedup
    const batchId = createHash("sha256")
      .update(`${filePath}:${offset}:${stat.size}:${validEntries.length}`)
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
      entries: validEntries,
    };

    // Ship — only advance offset on success
    try {
      await this.config.ship(batch);
      this.offsets[key] = stat.size;
      this.saveOffsets();
      return true;
    } catch {
      // Ship failed — offset NOT advanced, will retry on next poll
      return false;
    }
  }
}
