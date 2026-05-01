/**
 * Config — load and merge ~/.observer/config.yaml with defaults.
 *
 * The shipping side is structured around N independent **destinations**.
 * Each destination has its own endpoint, disclosure level, schedule,
 * scope filters, and cursor. The daemon parses each trace file once
 * per poll, then applies per-destination filters and ships independently.
 *
 * The legacy `ship:` shape is rejected at parse time (the codebase had
 * not reached production at the time of the cut). The error message
 * tells the user how to migrate.
 */

import { existsSync, readFileSync } from "node:fs";
import YAML from "yaml";
import type { DisclosureLevel } from "./types";

export type LogLevel = "silent" | "error" | "info" | "debug";

export type DestinationKind = "disk" | "http";
export type Schedule = "realtime" | "hourly" | "daily";

interface BaseDestination {
  /** Stable, user-friendly name. Also the cursor-file name on disk. */
  name: string;
  /** Path (disk) or URL (http). */
  endpoint: string;
  disclosure: DisclosureLevel;
  schedule: Schedule;
  useLocalTime: boolean;
  anonymize: boolean;
  redactSecrets: boolean;
  /** Repo-org allow/deny lists. Empty `include` means "no scope filter". */
  orgs: { include: string[]; exclude: string[] };
  /** Project (path or name) allow/deny lists. */
  projects: { include: string[]; exclude: string[] };
}

export interface DiskDestination extends BaseDestination {
  kind: "disk";
}

export interface HttpDestination extends BaseDestination {
  kind: "http";
  /** Literal API key (use `apiKeyEnv` to avoid baking secrets into config). */
  apiKey: string | null;
  /** Name of an env var holding the API key. */
  apiKeyEnv: string | null;
}

/** Discriminated union over the kind tag — disk-only fields aren't visible
 *  to http handlers and vice versa. Kind is inferred from the endpoint:
 *  http(s)://... → "http", anything else → "disk". */
export type Destination = DiskDestination | HttpDestination;

export interface DashboardConfig {
  port: number;
  uiPort: number;
  dataDir: string | null;
  log: {
    level: LogLevel;
    file: string | null;
    stderr: boolean;
  };
}

export interface ObserverConfig {
  sources: {
    claude_code: boolean;
    codex: boolean;
    cursor: boolean;
  };
  destinations: Destination[];
  git: {
    enabled: boolean;
    repos: Record<string, string[]>;
    onlySelf: boolean;
  };
  privacy: {
    /** Hard exclusion list — applied before any destination's filters.
     *  Sets a global floor: paths here never reach any destination. */
    excludeProjects: string[];
  };
  cursor: {
    fetchUsage: boolean;
  };
  dashboard: DashboardConfig;
  pollIntervalMs: number;
  developer: string | null;
  machine: string | null;
}

const DEFAULT_DESTINATION: Omit<BaseDestination, "name" | "endpoint"> = {
  disclosure: "moderate",
  schedule: "hourly",
  useLocalTime: false,
  anonymize: false,
  redactSecrets: true,
  orgs: { include: [], exclude: [] },
  projects: { include: [], exclude: [] },
};

export const DEFAULT_CONFIG: ObserverConfig = {
  sources: {
    claude_code: true,
    codex: true,
    cursor: true,
  },
  destinations: [],
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
  pollIntervalMs: 300_000,
  developer: null,
  machine: null,
};

function inferKind(endpoint: string): DestinationKind {
  return /^https?:\/\//.test(endpoint) ? "http" : "disk";
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : [];
}

function parseDestination(raw: Record<string, unknown>, idx: number): Destination {
  const name = typeof raw.name === "string" ? raw.name : `destination-${idx}`;
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  if (!endpoint) {
    throw new Error(`destinations[${idx}] (${name}): \`endpoint\` is required`);
  }
  const kind = inferKind(endpoint);

  const orgs = (raw.orgs ?? {}) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;

  const base: BaseDestination = {
    name,
    endpoint,
    disclosure: (raw.disclosure as DisclosureLevel) ?? DEFAULT_DESTINATION.disclosure,
    schedule: (raw.schedule as Schedule) ?? DEFAULT_DESTINATION.schedule,
    useLocalTime: raw.useLocalTime !== undefined ? Boolean(raw.useLocalTime) : DEFAULT_DESTINATION.useLocalTime,
    anonymize:    raw.anonymize    !== undefined ? Boolean(raw.anonymize)    : DEFAULT_DESTINATION.anonymize,
    redactSecrets: raw.redactSecrets !== undefined ? Boolean(raw.redactSecrets) : DEFAULT_DESTINATION.redactSecrets,
    orgs: {
      include: asStringArray(orgs.include),
      exclude: asStringArray(orgs.exclude),
    },
    projects: {
      include: asStringArray(projects.include),
      exclude: asStringArray(projects.exclude),
    },
  };

  if (kind === "disk") {
    return { ...base, kind: "disk" };
  }
  return {
    ...base,
    kind: "http",
    apiKey:    typeof raw.apiKey    === "string" ? raw.apiKey    : null,
    apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : null,
  };
}

/**
 * Translate a legacy `ship:` block into one or two destinations. Pure
 * in-memory transform; the user's config.yaml is never rewritten. The
 * caller is expected to log a one-line note so the user knows their
 * old shape is being adapted.
 *
 * Mapping:
 *   ship.localOutputDir → disk destination "local"
 *   ship.endpoint       → http destination "remote"
 *   ship.disclosure / redactSecrets / schedule / useLocalTime /
 *     anonymize → applied to BOTH destinations identically (the legacy
 *     shape conflated them, which is exactly the bug the new shape
 *     fixes — but we honour what the user wrote).
 */
function migrateLegacyShip(
  rawShip: Record<string, unknown>,
  developerOrgs: string[],
): Destination[] {
  const out: Destination[] = [];
  const disclosure = (rawShip.disclosure as DisclosureLevel) ?? DEFAULT_DESTINATION.disclosure;
  const schedule = (rawShip.schedule as Schedule) ?? DEFAULT_DESTINATION.schedule;
  const useLocalTime = rawShip.useLocalTime !== undefined ? Boolean(rawShip.useLocalTime) : DEFAULT_DESTINATION.useLocalTime;
  const anonymize = rawShip.anonymize !== undefined ? Boolean(rawShip.anonymize) : DEFAULT_DESTINATION.anonymize;
  const redactSecrets = rawShip.redactSecrets !== undefined ? Boolean(rawShip.redactSecrets) : DEFAULT_DESTINATION.redactSecrets;
  const orgs = { include: developerOrgs, exclude: [] as string[] };
  const projects = { include: [] as string[], exclude: [] as string[] };
  const baseFields = { disclosure, schedule, useLocalTime, anonymize, redactSecrets, orgs, projects };

  if (typeof rawShip.localOutputDir === "string" && rawShip.localOutputDir) {
    out.push({
      kind: "disk",
      name: "local",
      endpoint: rawShip.localOutputDir,
      ...baseFields,
    });
  }
  if (typeof rawShip.endpoint === "string" && rawShip.endpoint) {
    out.push({
      kind: "http",
      name: "remote",
      endpoint: rawShip.endpoint,
      apiKey:    typeof rawShip.apiKey    === "string" ? rawShip.apiKey    : null,
      apiKeyEnv: typeof rawShip.apiKeyEnv === "string" ? rawShip.apiKeyEnv : null,
      ...baseFields,
    });
  }
  return out;
}

const LEGACY_AND_NEW_BOTH_SET =
  `\`ship:\` and \`destinations:\` are both set. Pick one — \`destinations:\` ` +
  `is the supported shape; \`ship:\` is auto-migrated when present alone.`;

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

  const hasLegacyShip = "ship" in raw && typeof raw.ship === "object" && raw.ship !== null;
  const hasNewDestinations = "destinations" in raw && Array.isArray(raw.destinations);
  if (hasLegacyShip && hasNewDestinations) {
    throw new Error(LEGACY_AND_NEW_BOTH_SET);
  }

  const rawSources = (raw.sources ?? {}) as Record<string, unknown>;
  const rawDestinations = Array.isArray(raw.destinations) ? raw.destinations as unknown[] : [];
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
    destinations: hasLegacyShip
      ? migrateLegacyShip(raw.ship as Record<string, unknown>, [])
      : rawDestinations.map((d, i) =>
          parseDestination((d ?? {}) as Record<string, unknown>, i),
        ),
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
