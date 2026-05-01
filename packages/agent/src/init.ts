/**
 * Init — generate config from setup wizard answers.
 *
 * The interactive prompting is done in the CLI layer. This module
 * handles config generation and writing.
 *
 * The YAML keys here MUST match what `loadConfig` reads in config.ts.
 * loadConfig uses camelCase (`redactSecrets`, `localOutputDir`,
 * `pollIntervalMs`, etc.) and a flat `pollIntervalMs` rather than
 * `daemon.poll_interval_ms`. Earlier versions of this file wrote
 * snake_case keys that loadConfig silently ignored — answers vanished
 * on the first daemon poll.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DisclosureChoice = "basic" | "moderate" | "sensitive" | "full";

export type ApiKeySource = "keychain" | "env" | "literal" | "none";

export interface InitAnswers {
  developer: string;
  agents: {
    claude_code: boolean;
    codex: boolean;
    cursor: boolean;
  };
  includeOrgs: string[];
  endpoint: string | null;
  apiKey: string | null;
  /** How the API key is referenced in config.yaml. The actual key value
   *  (when not "literal") is delivered out-of-band — keychain entries
   *  are populated by the wizard at write time, env vars set by the
   *  user. "none" emits no auth field at all (Ed25519-only mode). */
  apiKeySource: ApiKeySource;
  /** Service name to use when apiKeySource = "keychain". Defaults to
   *  "observer.<destname>" but the wizard exposes it for clarity. */
  apiKeyKeychainService?: string;
  /** Env var name for apiKeySource = "env". Defaults to OBSERVER_API_KEY. */
  apiKeyEnvName?: string;
  enableDaemon: boolean;
  disclosure: DisclosureChoice;
  /** Where the disk-shipper writes normalized JSONL. Defaults to
   *  ~/.observer/traces/normalized so the dashboard finds data. */
  localOutputDir?: string | null;
}

/**
 * Generate a YAML config string from init answers.
 * Keys are camelCase to match the loadConfig schema.
 *
 * Two destinations are emitted by default: a `local-dashboard` disk
 * destination at `~/.observer/traces/normalized` (full disclosure) so the
 * dashboard works out of the box, and a `remote` http destination if the
 * user gave one. Each destination is independent — disclosure, schedule,
 * scope, and redact settings can differ.
 */
export function generateConfig(answers: InitAnswers): string {
  const localOutputDir = answers.localOutputDir
    ?? join(homedir(), ".observer", "traces", "normalized");

  // Local destination — drives the dashboard. Always enabled at full
  // disclosure since data never leaves the machine.
  const localBlock = `  - name: local-dashboard
    # endpoint: file path on this machine. Must match what
    # \`observer dashboard run\` reads (~/.observer/traces/normalized
    # by default). Change only if you also change the dashboard's
    # data-dir.
    endpoint: ${localOutputDir}
    # disclosure: full | sensitive | moderate | basic
    # full — keeps tool outputs and file contents (LOCAL ONLY; safe
    #   here because data never leaves the machine).
    disclosure: full
    # schedule: realtime | hourly | daily — flushes at this cadence.
    # Use realtime so the dashboard reflects new sessions promptly.
    schedule: realtime
    # useLocalTime: true bucket date partitions in your local TZ.
    # The dashboard groups by these buckets, so keeping it true makes
    # "today" mean today.
    useLocalTime: true
    # redactSecrets: 11 regex patterns mask AWS/GH/JWT/etc. Strongly
    # recommend leaving on even for the local destination — agent
    # traces routinely contain credentials in command output.
    redactSecrets: true
    # anonymize: replaces developer identity with a one-way hash. Off
    # locally — your dashboard should show your real identity.
    anonymize: false`;

  // Remote destination — only when the user specified an ingestor URL.
  // Disclosure follows the wizard's choice. Disk-only data can stay
  // "full" without leaking; HTTP egress should generally be at most
  // "sensitive" (no HIGH_RISK fields).
  let authLine = "    # auth not configured — set apiKey, apiKeyEnv, or apiKeyKeychain";
  switch (answers.apiKeySource) {
    case "keychain": {
      const svc = answers.apiKeyKeychainService ?? "observer.remote";
      authLine = `    apiKeyKeychain: ${svc}`;
      break;
    }
    case "env": {
      const name = answers.apiKeyEnvName ?? "OBSERVER_API_KEY";
      authLine = `    apiKeyEnv: ${name}`;
      break;
    }
    case "literal":
      authLine = answers.apiKey
        ? `    apiKey: ${answers.apiKey}`
        : "    # apiKey: null (using Ed25519 signing)";
      break;
    case "none":
      authLine = "    # apiKey: null (using Ed25519 signing)";
      break;
  }

  const remoteBlock = answers.endpoint
    ? `  - name: remote
    # endpoint: HTTPS URL of the central ingestor.
    endpoint: ${answers.endpoint}
${authLine}
    # disclosure: full disclosure is forbidden over HTTP (would leak
    # tool outputs + file contents). The wizard caps remote at
    # sensitive even if you picked full above.
    disclosure: ${answers.disclosure === "full" ? "sensitive" : answers.disclosure}
    # schedule: hourly batches kindly to the ingestor; switch to
    # realtime if you want live cross-developer dashboards (more
    # requests/second).
    schedule: hourly
    # useLocalTime: false → UTC partitioning. Cross-developer
    # analytics need a single timezone; UTC is the lingua franca.
    useLocalTime: false
    # redactSecrets: true is the right answer for any remote
    # destination. Setting false leaks credentials.
    redactSecrets: true
    # anonymize: replace developer identity with a hash. Useful for
    # corporate ingestors where the dashboard shouldn't tie token
    # spend to a specific person without explicit consent.
    anonymize: false${answers.includeOrgs.length > 0 ? `
    # orgs.include: only ship traces from repos under these GitHub
    # orgs. Empty includes = no scope filter (everything ships).
    orgs:
      include:
${answers.includeOrgs.map((o) => `        - ${o}`).join("\n")}` : ""}`
    : "";

  const destinationsBlock = remoteBlock
    ? `${localBlock}\n${remoteBlock}`
    : localBlock;

  return `# Observer agent configuration
# Generated by 'observer init'.
# Keys are camelCase to match the loader.

developer: ${answers.developer}

sources:
  claude_code: ${answers.agents.claude_code}
  codex: ${answers.agents.codex}
  cursor: ${answers.agents.cursor}

# Each destination has its own disclosure, schedule, scope, and redact
# settings. The disk destination drives the local dashboard; the http
# destination ships to a centralized ingestor.
destinations:
${destinationsBlock}

git:
  enabled: true
  repos: {}
  # Only collect commits authored by ${answers.developer}. Set to false
  # if you want teammates' commits in shared repos to show up too.
  onlySelf: true

privacy:
  # Hard exclusion list applied before any destination filter — a path
  # listed here never reaches any destination, regardless of per-dest
  # scope settings.
  excludeProjects: []

cursor:
  # Cursor doesn't write consumed-token counts to its local SQLite —
  # they only live on Cursor's servers. Set to true and the daemon will
  # read your local Cursor auth token (state.vscdb) and call Cursor's
  # dashboard API once per tick to fetch real per-day totals.
  # Tradeoff: that token is account-equivalent. Off by default.
  fetchUsage: false

# Daemon poll interval in milliseconds. 300000 = 5 minutes.
pollIntervalMs: 300000

# Dashboard server config (used by 'observer dashboard run').
dashboard:
  port: 3457
  uiPort: 3000
  dataDir: null            # null → ~/.observer/traces/normalized
  log:
    level: info            # silent | error | info | debug
    file: null             # null → ~/.observer/logs/dashboard.log
    stderr: false
`;
}

/**
 * Write config to the state directory.
 * Does not overwrite unless force=true.
 */
export function writeConfig(
  stateDir: string,
  content: string,
  force = false,
): void {
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, "config.yaml");

  if (existsSync(configPath) && !force) {
    return;
  }

  writeFileSync(configPath, content);
}
