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
import { createDiskShipper, shipCursorEntries } from "./disk-shipper";
import { scanGitEvents } from "./git/scanner";
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
  disclosure?: string;
  localTime?: boolean;
  git?: boolean;
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
            const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
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
  const disclosure = (opts.disclosure ?? "sensitive") as import("./types").DisclosureLevel;
  const diskShip = opts.localOutput
    ? createDiskShipper({ outputDir: opts.localOutput, disclosure, redactSecrets: opts.redactSecrets, useLocalTime: opts.localTime })
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
        if (!opts.localOutput) {
          console.log(`  [skip] ${source.agent}/${source.project}: Cursor SQLite requires --local-output`);
          continue;
        }
        try {
          const count = shipCursorEntries(file, {
            outputDir: opts.localOutput,
            disclosure,
            redactSecrets: opts.redactSecrets,
            useLocalTime: opts.localTime,
            developer: shipper.developer,
            machine: shipper.machine,
            stateDir: opts.stateDir,
          });
          if (count > 0) {
            batchCount++;
            entryCount += count;
          }
        } catch (err) {
          console.log(`  [error] ${source.agent}/${source.project}: ${err instanceof Error ? err.message : err}`);
          failCount++;
        }
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
      // No persistent retry queue — running `observer scan` again re-attempts
      // every source from scratch. The error lines above are the failures.
      console.log(`  ${failCount} source(s) errored (see [error] lines above) — re-run after fixing.`);
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

  // Git event collection
  if (opts.git !== false && opts.localOutput) {
    try {
      const { loadConfig } = await import("./config");
      const config = loadConfig(join(opts.stateDir, "config.yaml"));
      const gitCount = scanGitEvents({
        outputDir: opts.localOutput,
        stateDir: opts.stateDir,
        disclosure,
        developer: shipper.developer,
        machine: shipper.machine,
        extraRepos: Object.keys(config.git.repos).length > 0 ? config.git.repos : undefined,
      });
      if (gitCount > 0) {
        console.log(`Git: ${gitCount} event(s) collected`);
      }
    } catch (err) {
      console.log(`Git: collection failed — ${err instanceof Error ? err.message : err}`);
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
  const offsetFile = join(opts.stateDir, "shipper-offsets.json");
  if (existsSync(offsetFile)) {
    const offsets = JSON.parse(readFileSync(offsetFile, "utf-8"));
    const tracked = Object.keys(offsets).length;
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

  // Disclosure — what to keep in captured traces.
  // Local-only default is "full" (useful for the dashboard); anything being
  // shipped to a remote endpoint defaults to "basic" to avoid leaking output.
  const defaultDisclosure = endpoint ? "basic" : "full";
  console.log(`
Data capture level — how much detail to keep in each trace entry:
  basic      tool names and counts only
  moderate   + file paths, commands, git refs
  sensitive  + user prompts, assistant text, thinking traces
  full       + tool outputs, file contents   (LOCAL USE ONLY)
`);
  const disclosureRaw = (await ask(`Choice [basic|moderate|sensitive|full] [${defaultDisclosure}]: `)).trim().toLowerCase();
  const disclosure = (["basic", "moderate", "sensitive", "full"].includes(disclosureRaw)
    ? disclosureRaw
    : defaultDisclosure) as "basic" | "moderate" | "sensitive" | "full";
  if (disclosure === "full" && endpoint) {
    console.log("  ! Warning: 'full' includes tool outputs and file contents. Not recommended with a remote endpoint.");
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
    disclosure,
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

  console.log("\n✓ Done! What's next:");
  if (!enableDaemon) {
    console.log("  observer start          — run the collector on login");
  }
  console.log("  observer dashboard run  — open the dashboard in your browser");
  console.log("  observer scan           — run a one-shot scan now");
  console.log("  observer status         — show what's being monitored");
}

/**
 * Default action when `observer` is run with no subcommand.
 * - If no config exists → run init (first-run experience).
 * - Otherwise → print a short status pointer.
 */
async function defaultAction(): Promise<void> {
  const configPath = join(DEFAULT_STATE_DIR, "config.yaml");
  if (!existsSync(configPath)) {
    console.log("Welcome to observer. No config found — let's set it up.\n");
    await initAction();
    return;
  }
  console.log("observer — AI trace collector\n");
  console.log("Commands:");
  console.log("  observer dashboard run  — open the dashboard");
  console.log("  observer status         — show current state");
  console.log("  observer start / stop   — manage the background collector");
  console.log("  observer --help         — full reference");
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
        useLocalTime: config.ship.useLocalTime,
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
    localOutputDir: config.ship.localOutputDir ?? undefined,
    disclosure: config.ship.disclosure,
    useLocalTime: config.ship.useLocalTime,
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

// --- Dashboard ---

/** Open a URL in the user's default browser. Silent on failure. */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch { /* non-fatal — user can open manually */ }
}

async function dashboardRunAction(opts: {
  port?: string;
  noBrowser?: boolean;
  logLevel?: string;
}): Promise<void> {
  const { runDashboard } = await import("@observer/dashboard/runtime");
  const port = opts.port ? parseInt(opts.port, 10) : undefined;

  // Open browser shortly after server binds. runDashboard returns after the
  // server is listening; Bun.serve keeps the event loop alive.
  if (!opts.noBrowser) {
    const url = `http://localhost:${port ?? 3457}`;
    setTimeout(() => openBrowser(url), 500);
  }

  await runDashboard({
    ...(port ? { port } : {}),
    ...(opts.logLevel ? { logLevel: opts.logLevel as "silent" | "error" | "info" | "debug" } : {}),
  });
}

function dashboardStartAction(): void {
  const binaryPath = resolveBinaryPath();
  const result = installService({
    name: "dashboard",
    description: "Observer — dashboard server",
    args: ["dashboard", "run", "--no-browser"],
    binaryPath,
    homeDir: homedir(),
    logPath: join(DEFAULT_STATE_DIR, "logs", "dashboard-service.log"),
  });
  console.log(result.success ? `✓ ${result.message}` : `! ${result.message}`);
  if (result.success) {
    console.log(`  Open http://localhost:3457 to view.`);
  }
}

function dashboardStopAction(): void {
  const result = uninstallService(homedir(), "dashboard");
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
  .version("0.1.0")
  .action(defaultAction);

program
  .command("scan")
  .description("One-shot scan of all trace sources")
  .option("--claude-dir <path>", "Claude Code directory", DEFAULT_CLAUDE_DIR)
  .option("--codex-dir <path>", "Codex directory", DEFAULT_CODEX_DIR)
  .option("--cursor-dir <path>", "Cursor directory", DEFAULT_CURSOR_DIR)
  .option("--state-dir <path>", "State directory for offsets", DEFAULT_STATE_DIR)
  .option("--no-redact-secrets", "Disable secret redaction")
  .option("--dry-run", "Discover and count without shipping", false)
  .option("--developer <id>", "Developer identity override")
  .option("--endpoint <url>", "Ingestor endpoint URL (e.g. http://localhost:19900/api/ingest)")
  .option("--api-key <key>", "API key for ingestor auth")
  .option("--local-output <path>", "Write normalized traces to local directory")
  .option("--disclosure <level>", "Disclosure level: basic, moderate, sensitive, full", "sensitive")
  .option("--local-time", "Use local timezone for date partitioning (default: UTC)")
  .option("--no-git", "Skip git event collection")
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

const dashboard = program
  .command("dashboard")
  .description("Open the dashboard (serves traces + git events on localhost)");

dashboard
  .command("run", { isDefault: true })
  .description("Run the dashboard in foreground and open the browser")
  .option("--port <n>", "API + UI port")
  .option("--no-browser", "Don't open the browser automatically")
  .option("--log-level <lvl>", "silent | error | info | debug")
  .action(dashboardRunAction);

dashboard
  .command("start")
  .description("Install the dashboard as a background service (launchd/systemd)")
  .action(dashboardStartAction);

dashboard
  .command("stop")
  .description("Stop and uninstall the dashboard service")
  .action(dashboardStopAction);

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
