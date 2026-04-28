/**
 * Config — load and merge ~/.observer/config.yaml with defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import type { DisclosureLevel } from "./types";

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface DashboardConfig {
  /** Bun API server port */
  port: number;
  /** Next UI port (relevant once dashboard is folded into the CLI) */
  uiPort: number;
  /** Normalized traces dir. null → ~/.observer/traces/normalized */
  dataDir: string | null;
  log: {
    level: LogLevel;
    /** Log file path. null → ~/.observer/logs/dashboard.log */
    file: string | null;
    /** Mirror log lines to stderr */
    stderr: boolean;
  };
}

export interface ObserverConfig {
  sources: {
    claude_code: boolean;
    codex: boolean;
    cursor: boolean;
  };
  ship: {
    endpoint: string | null;
    localOutputDir: string | null;
    redactSecrets: boolean;
    schedule: "realtime" | "hourly" | "daily";
    disclosure: DisclosureLevel;
    useLocalTime: boolean;
    anonymize: boolean;
  };
  git: {
    enabled: boolean;
    /** Extra repo paths to scan, keyed by project name.
     *  e.g. { "db-mcp": ["/Users/dev/observer"] } */
    repos: Record<string, string[]>;
    /** When true, only collect commits authored by the configured developer
     *  (matched against author name + email). Prevents your dashboard from
     *  filling with teammates' commits in shared repos. Default true. */
    onlySelf: boolean;
  };
  privacy: {
    excludeProjects: string[];
  };
  cursor: {
    /** When true, the daemon will read Cursor's local auth token from
     *  state.vscdb and call Cursor's undocumented dashboard API to fetch
     *  real consumed-token totals (Cursor doesn't write these to disk).
     *  Off by default — the auth token is account-equivalent; opt in
     *  consciously. */
    fetchUsage: boolean;
  };
  dashboard: DashboardConfig;
  pollIntervalMs: number;
  developer: string | null;
  machine: string | null;
}

export const DEFAULT_CONFIG: ObserverConfig = {
  sources: {
    claude_code: true,
    codex: true,
    cursor: true,
  },
  ship: {
    endpoint: null,
    localOutputDir: null,
    redactSecrets: true,
    schedule: "hourly",
    disclosure: "basic" as DisclosureLevel,
    useLocalTime: false,
    anonymize: false,
  },
  git: {
    enabled: true,
    repos: {},
    onlySelf: true,
  },
  privacy: {
    excludeProjects: [],
  },
  cursor: {
    fetchUsage: false,
  },
  dashboard: {
    port: 3457,
    uiPort: 3000,
    dataDir: null,
    log: {
      level: "info",
      file: null,
      stderr: false,
    },
  },
  pollIntervalMs: 300_000, // 5 minutes
  developer: null,
  machine: null,
};

/**
 * Load config from a YAML file, merging with defaults.
 */
export function loadConfig(configPath: string): ObserverConfig {
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  let raw: Record<string, unknown>;
  try {
    const content = readFileSync(configPath, "utf-8");
    raw = (YAML.parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  const rawSources = (raw.sources ?? {}) as Record<string, unknown>;
  const rawShip = (raw.ship ?? {}) as Record<string, unknown>;
  const rawGit = (raw.git ?? {}) as Record<string, unknown>;
  const rawPrivacy = (raw.privacy ?? {}) as Record<string, unknown>;
  const rawCursor = (raw.cursor ?? {}) as Record<string, unknown>;
  const rawDash = (raw.dashboard ?? {}) as Record<string, unknown>;
  const rawDashLog = (rawDash.log ?? {}) as Record<string, unknown>;

  return {
    sources: {
      claude_code: rawSources.claude_code !== undefined
        ? Boolean(rawSources.claude_code)
        : DEFAULT_CONFIG.sources.claude_code,
      codex: rawSources.codex !== undefined
        ? Boolean(rawSources.codex)
        : DEFAULT_CONFIG.sources.codex,
      cursor: rawSources.cursor !== undefined
        ? Boolean(rawSources.cursor)
        : DEFAULT_CONFIG.sources.cursor,
    },
    ship: {
      endpoint: (rawShip.endpoint as string) ?? DEFAULT_CONFIG.ship.endpoint,
      localOutputDir: (rawShip.localOutputDir as string) ?? DEFAULT_CONFIG.ship.localOutputDir,
      redactSecrets: rawShip.redactSecrets !== undefined
        ? Boolean(rawShip.redactSecrets)
        : DEFAULT_CONFIG.ship.redactSecrets,
      schedule: (rawShip.schedule as ObserverConfig["ship"]["schedule"]) ??
        DEFAULT_CONFIG.ship.schedule,
      disclosure: (rawShip.disclosure as DisclosureLevel) ??
        DEFAULT_CONFIG.ship.disclosure,
      useLocalTime: rawShip.useLocalTime !== undefined
        ? Boolean(rawShip.useLocalTime)
        : DEFAULT_CONFIG.ship.useLocalTime,
      anonymize: rawShip.anonymize !== undefined
        ? Boolean(rawShip.anonymize)
        : DEFAULT_CONFIG.ship.anonymize,
    },
    git: {
      enabled: rawGit.enabled !== undefined
        ? Boolean(rawGit.enabled)
        : DEFAULT_CONFIG.git.enabled,
      repos: (rawGit.repos as Record<string, string[]>) ?? DEFAULT_CONFIG.git.repos,
      onlySelf: rawGit.onlySelf !== undefined
        ? Boolean(rawGit.onlySelf)
        : DEFAULT_CONFIG.git.onlySelf,
    },
    privacy: {
      excludeProjects: Array.isArray(rawPrivacy.excludeProjects)
        ? rawPrivacy.excludeProjects
        : DEFAULT_CONFIG.privacy.excludeProjects,
    },
    cursor: {
      fetchUsage: rawCursor.fetchUsage !== undefined
        ? Boolean(rawCursor.fetchUsage)
        : DEFAULT_CONFIG.cursor.fetchUsage,
    },
    dashboard: {
      port: typeof rawDash.port === "number" ? rawDash.port : DEFAULT_CONFIG.dashboard.port,
      uiPort: typeof rawDash.uiPort === "number" ? rawDash.uiPort : DEFAULT_CONFIG.dashboard.uiPort,
      dataDir: (rawDash.dataDir as string) ?? DEFAULT_CONFIG.dashboard.dataDir,
      log: {
        level: isLogLevel(rawDashLog.level) ? rawDashLog.level : DEFAULT_CONFIG.dashboard.log.level,
        file: (rawDashLog.file as string) ?? DEFAULT_CONFIG.dashboard.log.file,
        stderr: rawDashLog.stderr !== undefined
          ? Boolean(rawDashLog.stderr)
          : DEFAULT_CONFIG.dashboard.log.stderr,
      },
    },
    pollIntervalMs: typeof raw.pollIntervalMs === "number"
      ? raw.pollIntervalMs
      : DEFAULT_CONFIG.pollIntervalMs,
    developer: (raw.developer as string) ?? DEFAULT_CONFIG.developer,
    machine: (raw.machine as string) ?? DEFAULT_CONFIG.machine,
  };
}

function isLogLevel(v: unknown): v is LogLevel {
  return v === "silent" || v === "error" || v === "info" || v === "debug";
}
