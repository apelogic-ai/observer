/**
 * Dashboard config loader.
 *
 * Reads the canonical observer config at ~/.observer/config.yaml (overridable
 * via --config / OBSERVER_CONFIG), applies env and CLI overrides, and returns
 * a resolved DashboardConfig with no nullable path fields (defaults baked in).
 *
 * Precedence (highest first): CLI flags → env vars → config file → defaults.
 *
 * The `dashboard` section of the YAML is owned by packages/agent/src/config.ts.
 * We parse just that slice here to avoid a cross-package import; when the
 * dashboard is folded into the observer CLI, this module goes away.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface DashboardConfig {
  port: number;
  uiPort: number;
  dataDir: string;
  /** Static assets (out/ from `next build`) served at non-/api/* paths. */
  staticDir: string;
  configPath: string;
  log: {
    level: LogLevel;
    file: string;
    stderr: boolean;
  };
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".observer", "config.yaml");
const DEFAULT_DATA_DIR    = join(homedir(), ".observer", "traces", "normalized");
const DEFAULT_LOG_FILE    = join(homedir(), ".observer", "logs", "dashboard.log");
/** packages/dashboard/out/ when running from source. Override via --static-dir
 *  in the shipped binary where assets extract elsewhere. */
const DEFAULT_STATIC_DIR  = resolve(import.meta.dir, "..", "out");

const DEFAULTS = {
  port: 3457,
  uiPort: 3000,
  dataDir: DEFAULT_DATA_DIR,
  log: { level: "info" as LogLevel, file: DEFAULT_LOG_FILE, stderr: false },
};

/** Flags parsed from argv — pass only keys the user explicitly provided. */
export interface CliOverrides {
  port?: number;
  uiPort?: number;
  dataDir?: string;
  staticDir?: string;
  configPath?: string;
  logLevel?: LogLevel;
  logFile?: string;
  logStderr?: boolean;
}

export function loadDashboardConfig(cli: CliOverrides = {}): DashboardConfig {
  const configPath = cli.configPath
    ?? process.env.OBSERVER_CONFIG
    ?? DEFAULT_CONFIG_PATH;

  const fileCfg = readDashboardSection(configPath);

  // Merge: defaults → file → env → CLI
  const level = cli.logLevel
    ?? parseLogLevel(process.env.OBSERVER_LOG_LEVEL)
    ?? fileCfg.level
    ?? DEFAULTS.log.level;

  const logFile = cli.logFile
    ?? process.env.OBSERVER_LOG_FILE
    ?? fileCfg.logFile
    ?? DEFAULTS.log.file;

  const logStderr = cli.logStderr
    ?? (process.env.OBSERVER_LOG_STDERR === "1" ? true : undefined)
    ?? fileCfg.logStderr
    ?? DEFAULTS.log.stderr;

  const port = cli.port
    ?? parsePort(process.env.OBSERVER_PORT)
    ?? fileCfg.port
    ?? DEFAULTS.port;

  const uiPort = cli.uiPort
    ?? parsePort(process.env.OBSERVER_UI_PORT)
    ?? fileCfg.uiPort
    ?? DEFAULTS.uiPort;

  const dataDir = cli.dataDir
    ?? process.env.OBSERVER_DATA_DIR
    ?? fileCfg.dataDir
    ?? DEFAULTS.dataDir;

  const staticDir = cli.staticDir
    ?? process.env.OBSERVER_STATIC_DIR
    ?? DEFAULT_STATIC_DIR;

  return {
    port, uiPort, dataDir, staticDir, configPath,
    log: { level, file: logFile, stderr: logStderr },
  };
}

interface FileCfg {
  port?: number;
  uiPort?: number;
  dataDir?: string;
  level?: LogLevel;
  logFile?: string;
  logStderr?: boolean;
}

function readDashboardSection(path: string): FileCfg {
  if (!existsSync(path)) return {};
  let raw: Record<string, unknown>;
  try {
    raw = (YAML.parse(readFileSync(path, "utf-8")) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
  const dash = (raw.dashboard ?? {}) as Record<string, unknown>;
  const log  = (dash.log ?? {}) as Record<string, unknown>;
  return {
    port:      typeof dash.port === "number"   ? dash.port   : undefined,
    uiPort:    typeof dash.uiPort === "number" ? dash.uiPort : undefined,
    dataDir:   typeof dash.dataDir === "string" ? dash.dataDir : undefined,
    level:     parseLogLevel(log.level),
    logFile:   typeof log.file === "string" ? log.file : undefined,
    logStderr: typeof log.stderr === "boolean" ? log.stderr : undefined,
  };
}

function parseLogLevel(v: unknown): LogLevel | undefined {
  return v === "silent" || v === "error" || v === "info" || v === "debug" ? v : undefined;
}

function parsePort(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

/** Parse the subset of argv we support. Unknown flags fall through. */
export function parseCliArgs(argv: string[]): CliOverrides {
  const out: CliOverrides = {};
  const next = (i: number) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--port":        { const n = parseInt(next(i) ?? "", 10); if (Number.isFinite(n)) out.port = n; i++; break; }
      case "--ui-port":     { const n = parseInt(next(i) ?? "", 10); if (Number.isFinite(n)) out.uiPort = n; i++; break; }
      case "--data-dir":    { out.dataDir = next(i); i++; break; }
      case "--static-dir":  { out.staticDir = next(i); i++; break; }
      case "--config":      { out.configPath = next(i); i++; break; }
      case "--log-level":   { const lvl = parseLogLevel(next(i)); if (lvl) out.logLevel = lvl; i++; break; }
      case "--log-file":    { out.logFile = next(i); i++; break; }
      case "--log-stderr":  { out.logStderr = true; break; }
      case "--help":
      case "-h":            { printHelp(); process.exit(0); }
    }
  }
  return out;
}

function printHelp(): void {
  const home = homedir();
  process.stdout.write(`observer-dashboard — API server for the observer dashboard

Usage:
  bun server/index.ts [flags]

Flags:
  --port <n>           API server port (env: OBSERVER_PORT)
  --ui-port <n>        Next UI port (env: OBSERVER_UI_PORT)
  --data-dir <path>    Normalized traces dir (env: OBSERVER_DATA_DIR)
  --static-dir <path>  Dashboard static assets (env: OBSERVER_STATIC_DIR)
  --config <path>      Config file (env: OBSERVER_CONFIG)
  --log-level <lvl>    silent | error | info | debug (env: OBSERVER_LOG_LEVEL)
  --log-file <path>    Log file path (env: OBSERVER_LOG_FILE)
  --log-stderr         Mirror logs to stderr (env: OBSERVER_LOG_STDERR=1)
  -h, --help           Show this help

Config precedence: CLI > env > config file > defaults
Config file:       ${DEFAULT_CONFIG_PATH}
Default data dir:  ${DEFAULT_DATA_DIR.replace(home, "~")}
Default log file:  ${DEFAULT_LOG_FILE.replace(home, "~")}
`);
}
