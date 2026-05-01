import { describe, it, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateConfig,
  writeConfig,
  type InitAnswers,
} from "../src/init";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-init-"));
}

describe("generateConfig", () => {
  it("emits literal apiKey when apiKeySource = literal", () => {
    const answers: InitAnswers = {
      developer: "alice@acme.com",
      agents: { claude_code: true, codex: true, cursor: false },
      includeOrgs: ["acme-corp", "acme-data"],
      endpoint: "https://observer.acme.com/api/ingest",
      apiKey: "key_prod_123",
      apiKeySource: "literal",
      enableDaemon: true,
      disclosure: "sensitive",
    };

    const config = generateConfig(answers);
    expect(config).toContain("alice@acme.com");
    expect(config).toContain("claude_code: true");
    expect(config).toContain("https://observer.acme.com/api/ingest");
    expect(config).toContain("apiKey: key_prod_123");
    expect(config).not.toContain("apiKeyKeychain");
    expect(config).not.toContain("apiKeyEnv");
  });

  it("emits apiKeyKeychain when apiKeySource = keychain", () => {
    const answers: InitAnswers = {
      developer: "alice@acme.com",
      agents: { claude_code: true, codex: true, cursor: false },
      includeOrgs: [],
      endpoint: "https://observer.acme.com/api/ingest",
      apiKey: "secret_value",
      apiKeySource: "keychain",
      apiKeyKeychainService: "observer.remote",
      enableDaemon: true,
      disclosure: "moderate",
    };

    const config = generateConfig(answers);
    expect(config).toContain("apiKeyKeychain: observer.remote");
    // Critical: secret must NOT appear in the file when keychain is the source.
    expect(config).not.toContain("secret_value");
    expect(config).not.toContain("apiKey:");
  });

  it("emits apiKeyEnv when apiKeySource = env", () => {
    const answers: InitAnswers = {
      developer: "alice@acme.com",
      agents: { claude_code: true, codex: false, cursor: false },
      includeOrgs: [],
      endpoint: "https://observer.acme.com/api/ingest",
      apiKey: null,
      apiKeySource: "env",
      apiKeyEnvName: "OBSERVER_API_KEY",
      enableDaemon: true,
      disclosure: "moderate",
    };

    const config = generateConfig(answers);
    expect(config).toContain("apiKeyEnv: OBSERVER_API_KEY");
    expect(config).not.toContain("apiKeyKeychain");
  });

  it("emits no auth field when apiKeySource = none (Ed25519-only)", () => {
    const answers: InitAnswers = {
      developer: "alice@acme.com",
      agents: { claude_code: true, codex: false, cursor: false },
      includeOrgs: [],
      endpoint: "https://observer.acme.com/api/ingest",
      apiKey: null,
      apiKeySource: "none",
      enableDaemon: true,
      disclosure: "moderate",
    };

    const config = generateConfig(answers);
    // Parse the YAML and assert the remote destination has no auth keys
    // — string-matching on "apiKey: " would catch the comment line.
    const YAML = require("yaml") as typeof import("yaml");
    const parsed = YAML.parse(config) as { destinations: Record<string, unknown>[] };
    const remote = parsed.destinations.find((d) => d.name === "remote")!;
    expect(remote.apiKey).toBeUndefined();
    expect(remote.apiKeyEnv).toBeUndefined();
    expect(remote.apiKeyKeychain).toBeUndefined();
    expect(config).toContain("Ed25519 signing");
  });

  it("handles local-only mode (no endpoint) — single disk destination", () => {
    const answers: InitAnswers = {
      developer: "bob@example.com",
      agents: { claude_code: true, codex: false, cursor: false },
      includeOrgs: [],
      endpoint: null,
      apiKey: null,
      apiKeySource: "none",
      enableDaemon: false,
      disclosure: "full",
    };

    const config = generateConfig(answers);
    expect(config).toContain("destinations:");
    expect(config).toContain("- name: local-dashboard");
    expect(config).toContain(".observer/traces/normalized");
    // No remote destination when endpoint is null.
    expect(config).not.toContain("- name: remote");
  });

  it("generates valid YAML matching the loadConfig schema", () => {
    const answers: InitAnswers = {
      developer: "carol@test.com",
      agents: { claude_code: true, codex: true, cursor: true },
      includeOrgs: ["acme-corp"],
      endpoint: "http://localhost:19900/api/ingest",
      apiKey: null,
      apiKeySource: "none",
      enableDaemon: true,
      disclosure: "moderate",
    };

    const config = generateConfig(answers);
    const YAML = require("yaml") as typeof import("yaml");
    const parsed = YAML.parse(config) as Record<string, unknown>;
    expect(parsed.developer).toBe("carol@test.com");
    const sources = parsed.sources as Record<string, boolean>;
    expect(sources.claude_code).toBe(true);

    // Two destinations — local-dashboard (disk, full) + remote (http,
    // disclosure passed through).
    const dests = parsed.destinations as Array<Record<string, unknown>>;
    expect(dests).toHaveLength(2);
    expect(dests[0]!.name).toBe("local-dashboard");
    expect(dests[0]!.endpoint).toContain(".observer/traces/normalized");
    expect(dests[0]!.disclosure).toBe("full");
    expect(dests[1]!.name).toBe("remote");
    expect(dests[1]!.endpoint).toBe("http://localhost:19900/api/ingest");
    expect(dests[1]!.disclosure).toBe("moderate");

    // Top-level pollIntervalMs (NOT nested under daemon)
    expect(parsed.pollIntervalMs).toBe(300000);
    // Dashboard section so `observer dashboard run` finds defaults
    const dashboard = parsed.dashboard as Record<string, unknown>;
    expect(dashboard.port).toBe(3457);
  });

  it("downgrades remote disclosure from full to sensitive — full is local-only", () => {
    const answers: InitAnswers = {
      developer: "dan@test.com",
      agents: { claude_code: true, codex: false, cursor: false },
      includeOrgs: [],
      endpoint: "https://corp.example.com/api/ingest",
      apiKey: null,
      apiKeySource: "none",
      enableDaemon: true,
      disclosure: "full",   // disk gets "full", remote gets "sensitive"
    };

    const config = generateConfig(answers);
    const YAML = require("yaml") as typeof import("yaml");
    const parsed = YAML.parse(config) as Record<string, unknown>;
    const dests = parsed.destinations as Array<Record<string, unknown>>;
    expect(dests[0]!.disclosure).toBe("full");        // local
    expect(dests[1]!.disclosure).toBe("sensitive");   // remote
  });
});

describe("writeConfig", () => {
  it("writes config to ~/.observer/config.yaml", () => {
    const stateDir = makeTmpDir();
    const configContent = "developer: test@example.com\n";

    writeConfig(stateDir, configContent);

    const configPath = join(stateDir, "config.yaml");
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(configContent);
  });

  it("creates the directory if needed", () => {
    const baseDir = makeTmpDir();
    const stateDir = join(baseDir, "nested", ".observer");

    writeConfig(stateDir, "test: true\n");

    expect(existsSync(join(stateDir, "config.yaml"))).toBe(true);
  });

  it("does NOT overwrite existing config without force", () => {
    const stateDir = makeTmpDir();
    writeConfig(stateDir, "original: true\n");
    writeConfig(stateDir, "overwrite: true\n"); // should not overwrite

    const content = readFileSync(join(stateDir, "config.yaml"), "utf-8");
    expect(content).toContain("original");
  });

  it("overwrites with force flag", () => {
    const stateDir = makeTmpDir();
    writeConfig(stateDir, "original: true\n");
    writeConfig(stateDir, "overwrite: true\n", true);

    const content = readFileSync(join(stateDir, "config.yaml"), "utf-8");
    expect(content).toContain("overwrite");
  });
});
