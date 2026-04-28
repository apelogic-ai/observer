/**
 * Daemon — continuous polling loop for trace collection.
 * Discovers sources, processes new entries, ships via the Shipper.
 */

import { discoverTraceSources } from "./discover";
import { Shipper, type ShippedBatch } from "./shipper";
import { shipCursorEntries, type CursorShipConfig } from "./disk-shipper";
import { scanGitEvents } from "./git/scanner";
import { loadConfig } from "./config";
import { fetchAndWriteDailySidecar, readCursorAuth } from "./cursor-api";
import { join } from "node:path";
import type { DisclosureLevel } from "./types";

export interface DaemonConfig {
  claudeDir: string;
  codexDir: string;
  cursorDir: string;
  stateDir: string;
  pollIntervalMs: number;
  redactSecrets: boolean;
  developer?: string;
  machine?: string;
  onShip: (batch: ShippedBatch) => Promise<void>;
  onProgress?: (message: string) => void;
  /** Required for Cursor SQLite processing */
  localOutputDir?: string;
  disclosure?: DisclosureLevel;
  useLocalTime?: boolean;
  /** Collect git events alongside traces */
  collectGit?: boolean;
}

export class Daemon {
  private config: DaemonConfig;
  private shipper: Shipper;
  private progress: (msg: string) => void;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.progress = config.onProgress ?? (() => {});
    this.shipper = new Shipper({
      developer: config.developer,
      machine: config.machine,
      stateDir: config.stateDir,
      redactSecrets: config.redactSecrets,
      ship: config.onShip,
    });
  }

  /**
   * Run one poll cycle: discover sources, process new entries.
   */
  async pollOnce(): Promise<void> {
    const sources = discoverTraceSources({
      claudeCodeDir: this.config.claudeDir,
      codexDir: this.config.codexDir,
      cursorDir: this.config.cursorDir,
    });

    let shipped = 0;
    for (const source of sources) {
      for (const file of source.files) {
        if (file.endsWith(".vscdb")) {
          // Cursor SQLite — requires local output dir for normalized JSONL
          if (!this.config.localOutputDir) continue;
          try {
            const count = shipCursorEntries(file, {
              outputDir: this.config.localOutputDir,
              disclosure: this.config.disclosure ?? "sensitive",
              redactSecrets: this.config.redactSecrets,
              useLocalTime: this.config.useLocalTime,
              developer: this.shipper.developer,
              machine: this.shipper.machine,
              project: source.project,
              stateDir: this.config.stateDir,
            });
            if (count > 0) shipped++;
          } catch {
            // Cursor DB may be locked by the IDE — skip silently
          }
          continue;
        }
        const n = await this.shipper.processFile(file, source.agent, source.project);
        shipped += n;
      }
    }

    if (shipped > 0) {
      this.progress(`Shipped ${shipped} batch(es) from ${sources.length} source(s)`);
    }

    // Load config once for both git collection and cursor usage fetch
    let config: ReturnType<typeof loadConfig> | null = null;
    if (this.config.localOutputDir) {
      try { config = loadConfig(join(this.config.stateDir, "config.yaml")); }
      catch { config = null; }
    }

    // Git event collection
    if (this.config.collectGit !== false && this.config.localOutputDir && config) {
      try {
        const extraRepos = Object.keys(config.git.repos).length > 0 ? config.git.repos : undefined;
        const gitCount = scanGitEvents({
          outputDir: this.config.localOutputDir,
          stateDir: this.config.stateDir,
          disclosure: this.config.disclosure ?? "sensitive",
          developer: this.shipper.developer,
          machine: this.shipper.machine,
          extraRepos,
          onlySelf: config.git.onlySelf,
        });
        if (gitCount > 0) {
          this.progress(`Git: ${gitCount} event(s) collected`);
        }
      } catch {
        // Git collection is best-effort — don't crash the daemon
      }
    }

    // Cursor usage augmentation (opt-in). Cursor doesn't store consumed
    // tokens locally; this calls their dashboard API and writes a
    // <date>/cursor/_usage.json sidecar. Today + yesterday only — older
    // days are stable and only need a backfill via `observer cursor-usage`.
    if (config?.cursor.fetchUsage && this.config.localOutputDir) {
      const auth = readCursorAuth();
      if (auth) {
        const today = todayUtc();
        const yesterday = priorDay(today);
        for (const date of [yesterday, today]) {
          try {
            const r = await fetchAndWriteDailySidecar(this.config.localOutputDir, date, { auth });
            if (r.written) this.progress(`Cursor usage: refreshed ${date}`);
          } catch {
            // best-effort
          }
        }
      }
    }
  }

  /**
   * Start the continuous polling loop.
   */
  async run(): Promise<void> {
    this.progress("Starting daemon...");
    this.progress(`Developer: ${this.shipper.developer}`);
    this.progress(`Machine: ${this.shipper.machine}`);
    this.progress(`Poll interval: ${this.config.pollIntervalMs}ms`);

    // Initial poll
    await this.pollOnce();

    // Continuous polling
    setInterval(async () => {
      await this.pollOnce();
    }, this.config.pollIntervalMs);

    // Keep alive
    await new Promise(() => {});
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function priorDay(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
