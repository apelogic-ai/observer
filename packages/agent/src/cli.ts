#!/usr/bin/env bun
/**
 * observer — local daemon for AI trace collection.
 *
 * Commands:
 *   observer scan      One-shot scan of all trace sources
 *   observer status    Show discovered sources and counts
 *   observer watch     Daemon mode — continuous scanning
 *   observer ship      Ship pending batches to ingestor
 */

import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { discoverTraceSources, type TraceSource } from "./discover";
import { Shipper, type ShippedBatch } from "./shipper";
import { createHttpShipper } from "./http-shipper";
import { createDiskShipper } from "./disk-shipper";
import { generateKeypair, loadKeypair, getPublicKeyFingerprint } from "./identity";
import { generateConfig, writeConfig, type InitAnswers } from "./init";
import { installService, uninstallService, getServicePaths } from "./service";
import { Daemon, type DaemonConfig } from "./daemon";
import { createInterface } from "node:readline";

/**
 * Resolve the path to the observer binary.
 * When compiled: process.execPath is the binary itself.
 * When dev (bun src/cli.ts): fall back to ~/.local/bin/observer.
 */
function resolveBinaryPath(): string {
  const ep = process.execPath;
  // Compiled binary: execPath IS the observer binary (not bun/node)
  if (ep && !ep.includes("bun") && !ep.includes("node")) {
    return ep;
  }
  // Dev mode: check common install locations
  const candidates = [
    join(homedir(), ".local", "bin", "observer"),
    "/usr/local/bin/observer",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: assume it'll be installed later
  return join(homedir(), ".local", "bin", "observer");
}

const DEFAULT_STATE_DIR = join(homedir(), ".observer");
const DEFAULT_CLAUDE_DIR = join(homedir(), ".claude");
const DEFAULT_CODEX_DIR = join(homedir(), ".codex");
const DEFAULT_CURSOR_DIR = (() => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? "", "Cursor");
  }
  return join(homedir(), ".config", "Cursor");
})();

interface ScanOpts {
  claudeDir: string;
  codexDir: string;
  cursorDir: string;
  stateDir: string;
  redactSecrets: boolean;
  dryRun: boolean;
  developer?: string;
  endpoint?: string;
  apiKey?: string;
  localOutput?: string;
}

async function scanAction(opts: ScanOpts): Promise<void> {
  const sources = discoverTraceSources({
    claudeCodeDir: opts.claudeDir,
    codexDir: opts.codexDir,
    cursorDir: opts.cursorDir,
  });

  if (sources.length === 0) {
    console.log("No trace sources found.");
    return;
  }

  console.log(`Discovered ${sources.length} source(s):`);
  for (const s of sources) {
    console.log(`  ${s.agent} / ${s.project} — ${s.files.length} file(s)`);
  }

  if (opts.dryRun) {
    console.log("\n(dry run — not shipping)");

    // Still count entries per source
    let totalEntries = 0;
    for (const s of sources) {
      for (const f of s.files) {
        if (f.endsWith(".vscdb")) {
          // Cursor SQLite — count composerData keys
          try {
            const Database = require("better-sqlite3");
            const db = new Database(f, { readonly: true });
            const row = db.prepare(
              "SELECT COUNT(*) as cnt FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
            ).get() as { cnt: number };
            totalEntries += row.cnt;
            db.close();
          } catch { /* skip */ }
        } else {
          // JSONL — count lines
          const { readFileSync } = require("node:fs");
          const content = readFileSync(f, "utf-8");
          totalEntries += content.split("\n").filter((l: string) => l.trim()).length;
        }
      }
    }
    console.log(`Total entries across all sources: ${totalEntries}`);
    return;
  }

  // Ensure keypair exists
  generateKeypair(opts.stateDir);
  const keypair = loadKeypair(opts.stateDir) ?? undefined;

  // Set up shipping — HTTP, disk, both, or local logging
  const shipped: ShippedBatch[] = [];
  const httpShip = opts.endpoint
    ? createHttpShipper({ endpoint: opts.endpoint, apiKey: opts.apiKey, keypair })
    : null;
  const diskShip = opts.localOutput
    ? createDiskShipper({ outputDir: opts.localOutput, disclosure: "sensitive", redactSecrets: opts.redactSecrets })
    : null;

  const shipFn = httpShip && diskShip
    ? async (batch: ShippedBatch) => { await diskShip(batch); await httpShip(batch); }
    : httpShip ?? diskShip ?? (async (batch: ShippedBatch) => { shipped.push(batch); });

  const shipper = new Shipper({
    developer: opts.developer,
    stateDir: opts.stateDir,
    redactSecrets: opts.redactSecrets,
    ship: shipFn,
  });

  console.log(`\nDeveloper: ${shipper.developer}`);
  console.log(`Machine: ${shipper.machine}`);
  if (opts.endpoint) {
    console.log(`Endpoint: ${opts.endpoint}`);
  }
  if (opts.localOutput) {
    console.log(`Local output: ${opts.localOutput}`);
  }
  if (keypair) {
    console.log(`Signing: Ed25519 keypair loaded`);
  }
  console.log();

  let batchCount = 0;
  let entryCount = 0;
  let failCount = 0;

  for (const source of sources) {
    for (const file of source.files) {
      if (file.endsWith(".vscdb")) {
        console.log(`  [skip] ${source.agent}/${source.project}: SQLite shipping not yet wired`);
        continue;
      }
      const ok = await shipper.processFile(file, source.agent, source.project);
      if (ok) {
        batchCount++;
      }
    }
  }

  const destinations: string[] = [];
  if (opts.endpoint) destinations.push(opts.endpoint);
  if (opts.localOutput) destinations.push(opts.localOutput);

  if (destinations.length > 0) {
    console.log(`Shipped: ${batchCount} batch(es) to ${destinations.join(" + ")}`);
    if (failCount > 0) {
      console.log(`  ${failCount} batch(es) failed — will retry on next scan`);
    }
  } else {
    const totalEntries = shipped.reduce((sum, b) => sum + b.entries.length, 0);
    console.log(`Scanned: ${shipped.length} batch(es), ${totalEntries} new entries`);
    if (shipped.length > 0) {
      console.log("Batches (no sink configured — local only):");
      for (const b of shipped) {
        console.log(`  ${b.agent}/${b.project}: ${b.entries.length} entries`);
      }
    }
  }
}

interface StatusOpts {
  claudeDir: string;
  codexDir: string;
  cursorDir: string;
  stateDir: string;
}

function statusAction(opts: StatusOpts): void {
  const sources = discoverTraceSources({
    claudeCodeDir: opts.claudeDir,
    codexDir: opts.codexDir,
    cursorDir: opts.cursorDir,
  });

  console.log(`Trace sources: ${sources.length}`);
  if (sources.length === 0) {
    console.log("  (none found — check agent directories)");
    return;
  }

  for (const s of sources) {
    const fileDesc = s.files[0]?.endsWith(".vscdb") ? "database(s)" : "file(s)";
    console.log(`  ${s.agent} / ${s.project}: ${s.files.length} ${fileDesc}`);
  }

  // Show shipper state
  const { existsSync, readFileSync } = require("node:fs");
  const cursorFile = join(opts.stateDir, "shipper-cursors.json");
  if (existsSync(cursorFile)) {
    const cursors = JSON.parse(readFileSync(cursorFile, "utf-8"));
    const tracked = Object.keys(cursors).length;
    console.log(`\nShipper: tracking ${tracked} file(s)`);
  } else {
    console.log("\nShipper: no state yet (run scan first)");
  }
}

// --- Init wizard ---

async function initAction(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("Observer — AI agent trace collection\n");

  // Detect agents
  console.log("Detecting agents...");
  const agents = {
    claude_code: existsSync(join(homedir(), ".claude")),
    codex: existsSync(join(homedir(), ".codex")),
    cursor: existsSync(join(homedir(), "Library", "Application Support", "Cursor")) ||
      existsSync(join(homedir(), ".config", "Cursor")),
  };
  console.log(`  ${agents.claude_code ? "✓" : "○"} Claude Code`);
  console.log(`  ${agents.codex ? "✓" : "○"} Codex`);
  console.log(`  ${agents.cursor ? "✓" : "○"} Cursor`);

  // Developer identity
  let developer: string;
  try {
    developer = execSync("git config --global user.email", {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    developer = "";
  }
  if (developer) {
    const confirm = await ask(`\nDeveloper: ${developer} (from git config). Use this? [Y/n] `);
    if (confirm.trim().toLowerCase() === "n") {
      developer = await ask("Developer email or ID: ");
    }
  } else {
    developer = await ask("\nDeveloper email or ID: ");
  }

  // Scope
  const orgsInput = await ask("\nCorporate GitHub orgs (comma-separated, or Enter to skip): ");
  const includeOrgs = orgsInput.trim()
    ? orgsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Endpoint
  const endpointInput = await ask("\nIngestor endpoint URL (or Enter for local-only): ");
  const endpoint = endpointInput.trim() || null;

  let apiKey: string | null = null;
  if (endpoint) {
    const keyInput = await ask("API key (or Enter for Ed25519 signing): ");
    apiKey = keyInput.trim() || null;
  }

  // Daemon
  const daemonInput = await ask("\nStart observer on login? [Y/n] ");
  const enableDaemon = daemonInput.trim().toLowerCase() !== "n";

  rl.close();

  // Generate keypair
  console.log("\nGenerating Ed25519 keypair...");
  generateKeypair(DEFAULT_STATE_DIR);
  const kp = loadKeypair(DEFAULT_STATE_DIR);
  if (kp) {
    const fp = getPublicKeyFingerprint(kp.publicKeyPem);
    console.log(`  ✓ Keypair: ~/.observer/observer.key`);
    console.log(`  ✓ Fingerprint: ${fp.slice(0, 16)}...`);
  }

  // Write config
  const answers: InitAnswers = {
    developer,
    agents,
    includeOrgs,
    endpoint,
    apiKey,
    enableDaemon,
  };
  const configYaml = generateConfig(answers);
  writeConfig(DEFAULT_STATE_DIR, configYaml, true);
  console.log(`\n✓ Config written to ~/.observer/config.yaml`);

  // Install daemon
  if (enableDaemon) {
    const binaryPath = resolveBinaryPath();
    const result = installService({
      binaryPath,
      homeDir: homedir(),
      logPath: join(DEFAULT_STATE_DIR, "observer.log"),
    });
    console.log(result.success ? `✓ ${result.message}` : `! ${result.message}`);
  }

  console.log("\nDone! Commands:");
  console.log("  observer scan      — run a one-shot scan now");
  console.log("  observer status    — check what's being monitored");
  if (enableDaemon) {
    console.log("  observer start     — start the background daemon now");
  }
}

// --- Daemon foreground ---

async function daemonAction(opts: { stateDir: string }): Promise<void> {
  const { loadConfig } = await import("./config");
  const config = loadConfig(join(opts.stateDir, "config.yaml"));

  console.log("Observer daemon starting...");
  console.log(`  Developer: ${config.developer ?? "(auto)"}`);
  console.log(`  Poll interval: ${config.pollIntervalMs / 1000}s`);
  if (config.ship.endpoint) {
    console.log(`  Endpoint: ${config.ship.endpoint}`);
  }
  console.log();

  generateKeypair(opts.stateDir);
  const keypair = loadKeypair(opts.stateDir) ?? undefined;

  const httpShipDaemon = config.ship.endpoint
    ? createHttpShipper({ endpoint: config.ship.endpoint, keypair })
    : null;
  const diskShipDaemon = config.ship.localOutputDir
    ? createDiskShipper({
        outputDir: config.ship.localOutputDir,
        disclosure: config.ship.disclosure,
        redactSecrets: config.ship.redactSecrets,
      })
    : null;
  const shipFn = httpShipDaemon && diskShipDaemon
    ? async (batch: ShippedBatch) => { await diskShipDaemon(batch); await httpShipDaemon(batch); }
    : httpShipDaemon ?? diskShipDaemon ?? (async () => {});

  const daemon = new Daemon({
    claudeDir: DEFAULT_CLAUDE_DIR,
    codexDir: DEFAULT_CODEX_DIR,
    cursorDir: DEFAULT_CURSOR_DIR,
    stateDir: opts.stateDir,
    pollIntervalMs: config.pollIntervalMs,
    redactSecrets: config.ship.redactSecrets,
    developer: config.developer ?? undefined,
    onShip: shipFn,
    onProgress: (msg) => {
      const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
      console.log(`[${ts}] ${msg}`);
    },
  });

  await daemon.run();
}

// --- Start/Stop service ---

function startAction(): void {
  const binaryPath = resolveBinaryPath();
  const result = installService({
    binaryPath,
    homeDir: homedir(),
    logPath: join(DEFAULT_STATE_DIR, "observer.log"),
  });
  console.log(result.success ? `✓ ${result.message}` : `! ${result.message}`);
}

function stopAction(): void {
  const result = uninstallService(homedir());
  console.log(result.success ? `✓ ${result.message}` : `! ${result.message}`);
}

// --- Logs ---

function logsAction(opts: { stateDir: string; lines: string }): void {
  const logPath = join(opts.stateDir, "observer.log");
  if (!existsSync(logPath)) {
    console.log("No logs yet. Run 'observer start' or 'observer daemon' first.");
    return;
  }
  const content = readFileSync(logPath, "utf-8");
  const lines = content.split("\n");
  const n = parseInt(opts.lines) || 50;
  const tail = lines.slice(-n).join("\n");
  console.log(tail);
}

// --- Update ---

async function updateAction(): Promise<void> {
  const currentPath = resolveBinaryPath();
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = `${os}-${arch}`;

  console.log(`Current binary: ${currentPath}`);
  console.log(`Platform: ${target}`);
  console.log();

  // Fetch latest version from GitHub
  console.log("Checking for updates...");
  const repo = "observer-oss/observer";
  let latestTag: string;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases`);
    const releases = (await res.json()) as Array<{ tag_name: string }>;
    const observerRelease = releases.find((r) => r.tag_name.startsWith("observer-v"));
    if (!observerRelease) {
      console.log("No observer releases found. You may be running a dev build.");
      return;
    }
    latestTag = observerRelease.tag_name;
  } catch (err) {
    console.error("Failed to check for updates:", err instanceof Error ? err.message : err);
    return;
  }

  const latestVersion = latestTag.replace("observer-v", "");
  console.log(`Latest version: ${latestVersion}`);

  // Download
  const url = `https://github.com/${repo}/releases/download/${latestTag}/observer-${target}`;
  console.log(`Downloading observer-${target}...`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Download failed: ${res.status} ${res.statusText}`);
      return;
    }
    const data = await res.arrayBuffer();

    // Write to temp file, then rename (atomic replace)
    const tmpPath = currentPath + ".tmp";
    const { writeFileSync, renameSync, chmodSync } = require("node:fs");
    writeFileSync(tmpPath, Buffer.from(data));
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, currentPath);

    console.log(`✓ Updated to ${latestVersion}`);
    console.log(`  Binary: ${currentPath}`);

    // Restart daemon if running
    const paths = getServicePaths(process.platform, homedir());
    if (paths.plistPath && existsSync(paths.plistPath)) {
      console.log("  Restarting daemon...");
      try {
        execSync(`launchctl unload ${paths.plistPath}`, { stdio: "pipe" });
        execSync(`launchctl load ${paths.plistPath}`, { stdio: "pipe" });
        console.log("  ✓ Daemon restarted");
      } catch { /* manual restart needed */ }
    }
  } catch (err) {
    console.error("Update failed:", err instanceof Error ? err.message : err);
  }
}

// --- CLI wiring ---

const program = new Command();

program
  .name("observer")
  .description("Local agent for AI trace collection and shipping")
  .version("0.1.0");

program
  .command("scan")
  .description("One-shot scan of all trace sources")
  .option("--claude-dir <path>", "Claude Code directory", DEFAULT_CLAUDE_DIR)
  .option("--codex-dir <path>", "Codex directory", DEFAULT_CODEX_DIR)
  .option("--cursor-dir <path>", "Cursor directory", DEFAULT_CURSOR_DIR)
  .option("--state-dir <path>", "State directory for cursors", DEFAULT_STATE_DIR)
  .option("--no-redact-secrets", "Disable secret redaction")
  .option("--dry-run", "Discover and count without shipping", false)
  .option("--developer <id>", "Developer identity override")
  .option("--endpoint <url>", "Ingestor endpoint URL (e.g. http://localhost:19900/api/ingest)")
  .option("--api-key <key>", "API key for ingestor auth")
  .option("--local-output <path>", "Write normalized traces to local directory")
  .action(scanAction);

program
  .command("status")
  .description("Show discovered trace sources and shipper state")
  .option("--claude-dir <path>", "Claude Code directory", DEFAULT_CLAUDE_DIR)
  .option("--codex-dir <path>", "Codex directory", DEFAULT_CODEX_DIR)
  .option("--cursor-dir <path>", "Cursor directory", DEFAULT_CURSOR_DIR)
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .action(statusAction);

program
  .command("init")
  .description("Interactive setup wizard — detect agents, configure scope, generate keypair")
  .action(initAction);

program
  .command("daemon")
  .description("Run the daemon in foreground (for service managers)")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .action(daemonAction);

program
  .command("start")
  .description("Install and start background service (launchd/systemd)")
  .action(startAction);

program
  .command("stop")
  .description("Stop and uninstall background service")
  .action(stopAction);

program
  .command("logs")
  .description("Tail recent daemon logs")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("-n, --lines <n>", "Number of lines", "50")
  .action(logsAction);

program
  .command("update")
  .description("Update observer to the latest version")
  .action(updateAction);

program.parse();
