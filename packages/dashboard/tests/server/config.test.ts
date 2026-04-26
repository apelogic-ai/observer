import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDashboardConfig, parseCliArgs } from "../../server/config";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "observer-dash-cfg-"));
}

const TOUCHED_ENV = [
  "OBSERVER_LOG_LEVEL", "OBSERVER_LOG_FILE", "OBSERVER_LOG_STDERR",
  "OBSERVER_PORT", "OBSERVER_UI_PORT", "OBSERVER_DATA_DIR",
  "OBSERVER_BIND", "OBSERVER_CONFIG", "OBSERVER_STATIC_DIR",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of TOUCHED_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function writeConfig(yaml: string): string {
  const dir = makeTmpDir();
  const file = join(dir, "config.yaml");
  writeFileSync(file, yaml);
  return file;
}

describe("loadDashboardConfig precedence", () => {
  it("defaults when nothing is set", () => {
    const cfg = loadDashboardConfig({ configPath: "/no/such/file.yaml" });
    expect(cfg.port).toBe(3457);
    expect(cfg.uiPort).toBe(3000);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.log.level).toBe("info");
    expect(cfg.log.stderr).toBe(false);
    expect(cfg.dataDir).toContain(".observer/traces/normalized");
  });

  it("reads from the config file's dashboard section", () => {
    const file = writeConfig(`
dashboard:
  port: 9999
  bind: 0.0.0.0
  uiPort: 7000
  log:
    level: debug
    stderr: true
`);
    const cfg = loadDashboardConfig({ configPath: file });
    expect(cfg.port).toBe(9999);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.uiPort).toBe(7000);
    expect(cfg.log.level).toBe("debug");
    expect(cfg.log.stderr).toBe(true);
  });

  it("env vars override the config file", () => {
    const file = writeConfig(`
dashboard:
  port: 9999
  bind: 0.0.0.0
`);
    process.env.OBSERVER_PORT = "5555";
    process.env.OBSERVER_BIND = "127.0.0.1";
    process.env.OBSERVER_LOG_LEVEL = "error";

    const cfg = loadDashboardConfig({ configPath: file });
    expect(cfg.port).toBe(5555);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.log.level).toBe("error");
  });

  it("CLI flags override env and file", () => {
    const file = writeConfig(`
dashboard:
  port: 9999
  bind: 0.0.0.0
  log:
    level: debug
`);
    process.env.OBSERVER_PORT = "5555";
    process.env.OBSERVER_LOG_LEVEL = "error";

    const cfg = loadDashboardConfig({
      configPath: file,
      port: 1111,
      bind: "::1",
      logLevel: "silent",
    });
    expect(cfg.port).toBe(1111);
    expect(cfg.bind).toBe("::1");
    expect(cfg.log.level).toBe("silent");
  });

  it("rejects an invalid log level from env (falls back to default)", () => {
    process.env.OBSERVER_LOG_LEVEL = "loud";
    const cfg = loadDashboardConfig({ configPath: "/no/such/file.yaml" });
    expect(cfg.log.level).toBe("info");
  });

  it("rejects an invalid port from env (falls back to default)", () => {
    process.env.OBSERVER_PORT = "abc";
    const cfg = loadDashboardConfig({ configPath: "/no/such/file.yaml" });
    expect(cfg.port).toBe(3457);
    process.env.OBSERVER_PORT = "0";
    expect(loadDashboardConfig({ configPath: "/no/such/file.yaml" }).port).toBe(3457);
    process.env.OBSERVER_PORT = "70000";
    expect(loadDashboardConfig({ configPath: "/no/such/file.yaml" }).port).toBe(3457);
  });

  it("survives a malformed YAML config file (returns defaults)", () => {
    const file = writeConfig("this: : is\n: bad yaml ::");
    const cfg = loadDashboardConfig({ configPath: file });
    expect(cfg.port).toBe(3457);
  });
});

describe("parseCliArgs", () => {
  it("parses every supported flag", () => {
    const args = parseCliArgs([
      "--port", "1234", "--ui-port", "3000",
      "--data-dir", "/d", "--bind", "0.0.0.0",
      "--config", "/c.yaml", "--log-level", "debug",
      "--log-file", "/l.log", "--log-stderr",
      "--static-dir", "/s",
    ]);
    expect(args.port).toBe(1234);
    expect(args.uiPort).toBe(3000);
    expect(args.dataDir).toBe("/d");
    expect(args.bind).toBe("0.0.0.0");
    expect(args.configPath).toBe("/c.yaml");
    expect(args.logLevel).toBe("debug");
    expect(args.logFile).toBe("/l.log");
    expect(args.logStderr).toBe(true);
    expect(args.staticDir).toBe("/s");
  });

  it("ignores unknown flags rather than failing", () => {
    const args = parseCliArgs(["--port", "1234", "--unknown", "x", "--also-unknown"]);
    expect(args.port).toBe(1234);
  });

  it("ignores invalid log levels", () => {
    const args = parseCliArgs(["--log-level", "loud"]);
    expect(args.logLevel).toBeUndefined();
  });
});
