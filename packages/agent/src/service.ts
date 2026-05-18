/**
 * Service manager — generates and manages platform-native daemon services.
 *
 * Parameterized so one function installs either the collector daemon or the
 * dashboard server: both run the same observer binary with different argv.
 *
 * macOS: launchd (~/Library/LaunchAgents/com.observer.<name>.plist)
 * Linux: systemd user service (~/.config/systemd/user/observer-<name>.service)
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export interface ServiceConfig {
  /** Short name, used in the service label / filename. "agent" by default. */
  name?: string;
  /** Human description shown in systemd `Description=`. */
  description?: string;
  /** Arguments to pass to the binary. Defaults to ["daemon"] for backwards
   *  compat with the original collector-service call sites. */
  args?: string[];
  binaryPath: string;
  homeDir: string;
  logPath: string;
}

export interface ServicePaths {
  plistPath?: string;
  unitPath?: string;
  platform: string;
}

export interface RotateLogOptions {
  /** Rotate once the active log is larger than this many bytes. */
  maxBytes?: number;
  /** Number of rotated files to keep: observer.log.1 ... observer.log.N. */
  keep?: number;
}

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_KEEP = 5;

function resolveName(config: ServiceConfig): string {
  return config.name ?? "agent";
}

function resolveArgs(config: ServiceConfig): string[] {
  return config.args ?? ["daemon"];
}

function resolveDescription(config: ServiceConfig): string {
  return config.description ?? "Observer — AI trace collection";
}

function launchdLabel(name: string): string {
  return `com.observer.${name}`;
}

function systemdUnitName(name: string): string {
  // Keep the default 'agent' unit file at `observer.service` so existing
  // installs aren't orphaned on upgrade; new services (e.g. dashboard)
  // get a hyphenated suffix.
  return name === "agent" ? "observer.service" : `observer-${name}.service`;
}

export function generateLaunchdPlist(config: ServiceConfig): string {
  const label = launchdLabel(resolveName(config));
  const args = resolveArgs(config);
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.binaryPath)}</string>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(config.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(config.homeDir)}</string>
  </dict>
</dict>
</plist>`;
}

export function generateSystemdUnit(config: ServiceConfig): string {
  const command = [config.binaryPath, ...resolveArgs(config)]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=${resolveDescription(config)}
After=network.target

[Service]
ExecStart=${command}
Restart=on-failure
RestartSec=60
Environment=${systemdQuote(`HOME=${config.homeDir}`)}

[Install]
WantedBy=default.target`;
}

export function rotateLogFile(logPath: string, opts: RotateLogOptions = {}): boolean {
  if (!existsSync(logPath)) return false;
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const keep = Math.max(1, opts.keep ?? DEFAULT_LOG_KEEP);
  const stat = statSync(logPath);
  if (!stat.isFile() || stat.size <= maxBytes) return false;

  const oldest = `${logPath}.${keep}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    if (existsSync(src)) renameSync(src, `${logPath}.${i + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
  return true;
}

export function getServicePaths(
  platform: string,
  homeDir: string,
  name: string = "agent",
): ServicePaths {
  if (platform === "darwin") {
    return {
      plistPath: join(homeDir, "Library", "LaunchAgents", `${launchdLabel(name)}.plist`),
      platform: "darwin",
    };
  }
  if (platform === "linux") {
    return {
      unitPath: join(homeDir, ".config", "systemd", "user", systemdUnitName(name)),
      platform: "linux",
    };
  }
  return { platform };
}

export function installService(config: ServiceConfig): {
  success: boolean;
  message: string;
} {
  const platform = process.platform;
  const name = resolveName(config);
  const paths = getServicePaths(platform, config.homeDir, name);
  const prettyName = name === "agent" ? "Daemon" : cap(name);

  if (platform === "darwin" && paths.plistPath) {
    const plist = generateLaunchdPlist(config);
    mkdirSync(dirname(paths.plistPath), { recursive: true });
    mkdirSync(dirname(config.logPath), { recursive: true });
    rotateLogFile(config.logPath);
    writeFileSync(paths.plistPath, plist);

    try {
      // Argv-form invocation — paths are passed as a separate arg, no
      // shell interpolation, no risk of word-splitting on spaces or
      // injection through path components.
      // Unload first if already loaded (idempotent).
      try {
        execFileSync("launchctl", ["unload", paths.plistPath], { stdio: "pipe" });
      } catch { /* not loaded, fine */ }

      execFileSync("launchctl", ["load", paths.plistPath], { stdio: "pipe" });
      return {
        success: true,
        message: `${prettyName} installed: ${paths.plistPath}\nStarted via launchd. Will run on login.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to load launchd service: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  if (platform === "linux" && paths.unitPath) {
    const unit = generateSystemdUnit(config);
    const unitFile = systemdUnitName(name);
    mkdirSync(dirname(paths.unitPath), { recursive: true });
    mkdirSync(dirname(config.logPath), { recursive: true });
    rotateLogFile(config.logPath);
    writeFileSync(paths.unitPath, unit);

    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      execFileSync("systemctl", ["--user", "enable", "--now", unitFile], { stdio: "pipe" });
      return {
        success: true,
        message: `${prettyName} installed: ${paths.unitPath}\nStarted via systemd. Will run on login.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to enable systemd service: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  return {
    success: false,
    message: `Unsupported platform: ${platform}. Run the binary with its arguments manually.`,
  };
}

export function uninstallService(homeDir: string, name: string = "agent"): {
  success: boolean;
  message: string;
} {
  const platform = process.platform;
  const paths = getServicePaths(platform, homeDir, name);
  const prettyName = name === "agent" ? "Daemon" : cap(name);

  if (platform === "darwin" && paths.plistPath) {
    try {
      if (existsSync(paths.plistPath)) {
        execFileSync("launchctl", ["unload", paths.plistPath], { stdio: "pipe" });
        unlinkSync(paths.plistPath);
      }
      return { success: true, message: `${prettyName} stopped and uninstalled.` };
    } catch (err) {
      return {
        success: false,
        message: `Failed to unload: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  if (platform === "linux" && paths.unitPath) {
    const unitFile = systemdUnitName(name);
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", unitFile], { stdio: "pipe" });
      if (existsSync(paths.unitPath)) {
        unlinkSync(paths.unitPath);
      }
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
      return { success: true, message: `${prettyName} stopped and uninstalled.` };
    } catch (err) {
      return {
        success: false,
        message: `Failed to disable: ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  return {
    success: false,
    message: `Unsupported platform: ${platform}`,
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")}"`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
