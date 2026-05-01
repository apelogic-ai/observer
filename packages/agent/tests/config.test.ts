import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../src/config";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-config-"));
}

function writeConfig(yaml: string): string {
  const dir = makeTmpDir();
  const configFile = join(dir, "config.yaml");
  writeFileSync(configFile, yaml);
  return configFile;
}

describe("loadConfig — defaults", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/config.yaml");
    expect(config.sources.claude_code).toBe(true);
    expect(config.sources.codex).toBe(true);
    expect(config.sources.cursor).toBe(true);
    expect(config.destinations).toEqual([]);
    expect(config.pollIntervalMs).toBeGreaterThan(0);
  });

  it("DEFAULT_CONFIG is sane", () => {
    expect(DEFAULT_CONFIG.pollIntervalMs).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.sources.claude_code).toBe(true);
    expect(DEFAULT_CONFIG.destinations).toEqual([]);
  });
});

describe("loadConfig — destinations", () => {
  it("parses a disk destination (path → kind=disk)", () => {
    const config = loadConfig(writeConfig(`
developer: alice@acme.com
destinations:
  - name: local-dashboard
    endpoint: ~/.observer/traces/normalized
    disclosure: full
    schedule: realtime
    useLocalTime: true
`));
    expect(config.destinations).toHaveLength(1);
    const d = config.destinations[0]!;
    expect(d.name).toBe("local-dashboard");
    expect(d.kind).toBe("disk");
    expect(d.endpoint).toBe("~/.observer/traces/normalized");
    expect(d.disclosure).toBe("full");
    expect(d.schedule).toBe("realtime");
    expect(d.useLocalTime).toBe(true);
    // Defaults preserved when fields are absent.
    expect(d.anonymize).toBe(false);
    expect(d.redactSecrets).toBe(true);
    expect(d.orgs.include).toEqual([]);
    expect(d.orgs.exclude).toEqual([]);
    expect(d.projects.include).toEqual([]);
    expect(d.projects.exclude).toEqual([]);
  });

  it("parses an http destination (https://… → kind=http)", () => {
    const config = loadConfig(writeConfig(`
destinations:
  - name: corp-ingestor
    endpoint: https://api.observer.acme.com/api/ingest
    apiKeyEnv: CORP_API_KEY
    disclosure: moderate
    schedule: hourly
    anonymize: true
    orgs:
      include: [acme-corp]
    projects:
      exclude: [/Users/me/personal]
`));
    expect(config.destinations).toHaveLength(1);
    const d = config.destinations[0]!;
    expect(d.kind).toBe("http");
    expect(d.endpoint).toBe("https://api.observer.acme.com/api/ingest");
    expect(d.apiKeyEnv).toBe("CORP_API_KEY");
    expect(d.disclosure).toBe("moderate");
    expect(d.schedule).toBe("hourly");
    expect(d.anonymize).toBe(true);
    expect(d.orgs.include).toEqual(["acme-corp"]);
    expect(d.projects.exclude).toEqual(["/Users/me/personal"]);
  });

  it("parses N destinations independently", () => {
    const config = loadConfig(writeConfig(`
destinations:
  - name: local
    endpoint: ~/.observer/traces/normalized
    disclosure: full
    schedule: realtime
  - name: corp
    endpoint: https://corp.example.com/api/ingest
    apiKeyEnv: CORP_KEY
    disclosure: moderate
    schedule: hourly
  - name: security
    endpoint: https://sec.example.com/api/ingest
    apiKeyEnv: SEC_KEY
    disclosure: basic
    schedule: hourly
`));
    expect(config.destinations.map((d) => d.name)).toEqual(["local", "corp", "security"]);
    expect(config.destinations[0]!.kind).toBe("disk");
    expect(config.destinations[1]!.kind).toBe("http");
    expect(config.destinations[2]!.kind).toBe("http");
    // Each destination keeps its own disclosure, no cross-contamination.
    expect(config.destinations[0]!.disclosure).toBe("full");
    expect(config.destinations[1]!.disclosure).toBe("moderate");
    expect(config.destinations[2]!.disclosure).toBe("basic");
  });

  it("treats absolute paths and ~/-paths as disk; only http(s):// is http", () => {
    const config = loadConfig(writeConfig(`
destinations:
  - { name: a, endpoint: /var/lib/observer }
  - { name: b, endpoint: ~/observer }
  - { name: c, endpoint: ./observer }
  - { name: d, endpoint: file:///tmp/observer }
  - { name: e, endpoint: http://localhost:19900/api/ingest }
  - { name: f, endpoint: https://api.example.com/api/ingest }
`));
    const kinds = config.destinations.map((d) => d.kind);
    expect(kinds).toEqual(["disk", "disk", "disk", "disk", "http", "http"]);
  });
});

describe("loadConfig — legacy ship: auto-migration", () => {
  it("translates legacy ship.localOutputDir into a disk destination", () => {
    const config = loadConfig(writeConfig(`
ship:
  localOutputDir: ~/.observer/traces/normalized
  disclosure: full
  redactSecrets: true
  useLocalTime: true
`));
    expect(config.destinations).toHaveLength(1);
    const d = config.destinations[0]!;
    expect(d.kind).toBe("disk");
    expect(d.name).toBe("local");
    expect(d.endpoint).toBe("~/.observer/traces/normalized");
    expect(d.disclosure).toBe("full");
    expect(d.redactSecrets).toBe(true);
    expect(d.useLocalTime).toBe(true);
  });

  it("translates legacy ship.endpoint into an http destination", () => {
    const config = loadConfig(writeConfig(`
ship:
  endpoint: https://api.example.com/api/ingest
  apiKey: key_legacy_123
  disclosure: moderate
`));
    expect(config.destinations).toHaveLength(1);
    const d = config.destinations[0]!;
    expect(d.kind).toBe("http");
    expect(d.name).toBe("remote");
    expect(d.endpoint).toBe("https://api.example.com/api/ingest");
    expect(d.disclosure).toBe("moderate");
    if (d.kind === "http") expect(d.apiKey).toBe("key_legacy_123");
  });

  it("translates a fully-populated legacy ship: into two destinations", () => {
    const config = loadConfig(writeConfig(`
ship:
  endpoint: https://corp.example.com/api/ingest
  apiKeyEnv: CORP_KEY
  localOutputDir: /var/observer/traces
  disclosure: sensitive
  schedule: hourly
  useLocalTime: false
  anonymize: true
  redactSecrets: true
`));
    expect(config.destinations).toHaveLength(2);
    const local = config.destinations.find((d) => d.kind === "disk")!;
    const remote = config.destinations.find((d) => d.kind === "http")!;
    expect(local.endpoint).toBe("/var/observer/traces");
    expect(local.disclosure).toBe("sensitive");
    expect(local.anonymize).toBe(true);
    expect(remote.endpoint).toBe("https://corp.example.com/api/ingest");
    expect(remote.disclosure).toBe("sensitive");
    expect(remote.anonymize).toBe(true);
    if (remote.kind === "http") expect(remote.apiKeyEnv).toBe("CORP_KEY");
  });

  it("rejects configs that set BOTH ship: and destinations: — pick one", () => {
    expect(() => loadConfig(writeConfig(`
ship:
  endpoint: https://old.example.com/api/ingest
destinations:
  - name: new
    endpoint: https://new.example.com/api/ingest
`))).toThrow(/both/i);
  });
});

import { resolveDestinationApiKey } from "../src/config";
import type { HttpDestination } from "../src/config";

function httpDest(over: Partial<HttpDestination> = {}): HttpDestination {
  return {
    kind: "http",
    name: "test",
    endpoint: "https://x.example.com/api/ingest",
    disclosure: "moderate",
    schedule: "hourly",
    useLocalTime: false,
    anonymize: false,
    redactSecrets: true,
    apiKey: null,
    apiKeyEnv: null,
    orgs: { include: [], exclude: [] },
    projects: { include: [], exclude: [] },
    ...over,
  };
}

describe("resolveDestinationApiKey", () => {
  it("returns the literal apiKey when set", () => {
    const dest = httpDest({ apiKey: "literal_key", apiKeyEnv: "SHOULD_NOT_BE_USED" });
    expect(resolveDestinationApiKey(dest, { SHOULD_NOT_BE_USED: "env_value" })).toBe("literal_key");
  });

  it("reads from the env var named in apiKeyEnv when apiKey is null", () => {
    const dest = httpDest({ apiKey: null, apiKeyEnv: "OBSERVER_API_KEY" });
    expect(resolveDestinationApiKey(dest, { OBSERVER_API_KEY: "from_env" })).toBe("from_env");
  });

  it("returns null when apiKeyEnv names a missing env var", () => {
    const dest = httpDest({ apiKey: null, apiKeyEnv: "NOT_SET" });
    expect(resolveDestinationApiKey(dest, {})).toBeNull();
  });

  it("returns null when neither apiKey nor apiKeyEnv is set", () => {
    expect(resolveDestinationApiKey(httpDest())).toBeNull();
  });

  it("treats empty-string env var as missing", () => {
    const dest = httpDest({ apiKey: null, apiKeyEnv: "BLANK" });
    expect(resolveDestinationApiKey(dest, { BLANK: "" })).toBeNull();
  });
});

describe("loadConfig — sources / git / privacy / dashboard / pollIntervalMs", () => {
  it("parses sources", () => {
    const config = loadConfig(writeConfig(`
sources:
  claude_code: true
  codex: false
  cursor: true
`));
    expect(config.sources.codex).toBe(false);
  });

  it("parses pollIntervalMs", () => {
    const config = loadConfig(writeConfig(`pollIntervalMs: 30000`));
    expect(config.pollIntervalMs).toBe(30000);
  });

  it("merges partial config with defaults — destinations missing means none configured", () => {
    const config = loadConfig(writeConfig(`
sources:
  cursor: false
`));
    expect(config.sources.cursor).toBe(false);
    expect(config.sources.claude_code).toBe(true);
    expect(config.destinations).toEqual([]);
  });
});
