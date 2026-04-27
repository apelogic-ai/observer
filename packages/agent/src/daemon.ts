/**
 * Daemon — continuous polling loop for trace collection.
 * Discovers sources, processes new entries, ships via the Shipper.
 */

import { discoverTraceSources } from "./discover";
import { Shipper, type ShippedBatch } from "./shipper";
import { shipCursorEntries, type CursorShipConfig } from "./disk-shipper";
import { scanGitEvents } from "./git/scanner";
import { loadConfig } from "./config";
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

    // Git event collection
    if (this.config.collectGit !== false && this.config.localOutputDir) {
      try {
        const config = loadConfig(join(this.config.stateDir, "config.yaml"));
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
