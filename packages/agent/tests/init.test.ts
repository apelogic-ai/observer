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
  it("generates config from init answers", () => {
    const answers: InitAnswers = {
      developer: "alice@acme.com",
      agents: { claude_code: true, codex: true, cursor: false },
      includeOrgs: ["acme-corp", "acme-data"],
      endpoint: "https://observer.acme.com/api/ingest",
      apiKey: "key_prod_123",
      enableDaemon: true,
      disclosure: "sensitive",
    };

    const config = generateConfig(answers);
    expect(config).toContain("alice@acme.com");
    expect(config).toContain("claude_code: true");
    expect(config).toContain("codex: true");
    expect(config).toContain("cursor: false");
    expect(config).toContain("https://observer.acme.com/api/ingest");
    expect(config).toContain("apiKey: key_prod_123");
    expect(config).toContain("disclosure: sensitive");
  });

  it("handles local-only mode (no endpoint)", () => {
    const answers: InitAnswers = {
      developer: "bob@example.com",
      agents: { claude_code: true, codex: false, cursor: false },
      includeOrgs: [],
      endpoint: null,
      apiKey: null,
      enableDaemon: false,
      disclosure: "full",
    };

    const config = generateConfig(answers);
    expect(config).toContain("endpoint: null");
    // Ed25519 fallback note when no apiKey
    expect(config).toContain("Ed25519 signing");
    // Disk shipper default location populated by generateConfig
    expect(config).toContain("localOutputDir:");
    expect(config).toContain(".observer/traces/normalized");
  });

  it("generates valid YAML matching the loadConfig schema", () => {
    const answers: InitAnswers = {
      developer: "carol@test.com",
      agents: { claude_code: true, codex: true, cursor: true },
      includeOrgs: [],
      endpoint: "http://localhost:19900/api/ingest",
      apiKey: null,
      enableDaemon: true,
      disclosure: "basic",
    };

    const config = generateConfig(answers);
    const YAML = require("yaml") as typeof import("yaml");
    const parsed = YAML.parse(config) as Record<string, unknown>;
    expect(parsed.developer).toBe("carol@test.com");
    const sources = parsed.sources as Record<string, boolean>;
    expect(sources.claude_code).toBe(true);
    const ship = parsed.ship as Record<string, unknown>;
    expect(ship.endpoint).toBe("http://localhost:19900/api/ingest");
    expect(ship.disclosure).toBe("basic");
    expect(ship.redactSecrets).toBe(true);
    expect(typeof ship.localOutputDir).toBe("string");
    // Top-level pollIntervalMs (NOT nested under daemon)
    expect(parsed.pollIntervalMs).toBe(300000);
    // Dashboard section so `observer dashboard run` finds defaults
    const dashboard = parsed.dashboard as Record<string, unknown>;
    expect(dashboard.port).toBe(3457);
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
