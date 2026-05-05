/**
 * SecureStore — small abstraction over OS-native keychains.
 *
 * Backends:
 *   - macOS: /usr/bin/security (login keychain, hardware-backed on
 *     Apple Silicon via Secure Enclave)
 *   - Linux: secret-tool (libsecret → gnome-keyring / kwallet bridge)
 *   - elsewhere: NoOpStore that returns null on read and throws on
 *     write, so misconfiguration surfaces immediately rather than
 *     silently dropping secrets
 *
 * The CLI shells out (no third-party deps; cross-platform keyring
 * libraries are sparsely maintained). Secrets travel over stdin, not
 * the command line, so they don't appear in `ps` or shell history.
 */

import { spawnSync } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { input?: string },
) => ExecResult;

const defaultExec: Exec = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    input: opts?.input,
    encoding: "utf-8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
};

export interface SecureStore {
  /** Identifier for logs, e.g. "macos-keychain", "secret-tool". */
  readonly name: string;
  put(service: string, account: string, secret: string): Promise<void>;
  /** Returns null if not found. */
  get(service: string, account: string): Promise<string | null>;
  /** No-op if absent. */
  delete(service: string, account: string): Promise<void>;
}

/* ── macOS ────────────────────────────────────────────────────── */

export class MacosKeychain implements SecureStore {
  readonly name = "macos-keychain";
  constructor(private exec: Exec = defaultExec) {}

  async put(service: string, account: string, secret: string): Promise<void> {
    // Apple's `security add-generic-password` has no stdin path for the
    // password: the documented forms are `-w <password>` (value as
    // argv) or trailing `-w` (interactive TTY prompt). We use the
    // value form because we have no TTY in non-interactive flows. -U
    // must precede the password pair so the password isn't parsed as a
    // flag value for something else.
    const r = this.exec(
      "/usr/bin/security",
      ["add-generic-password", "-a", account, "-s", service, "-U", "-w", secret],
    );
    if (r.status !== 0) {
      throw new Error(
        `keychain: failed to store ${service}/${account}: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    const r = this.exec(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
    );
    if (r.status === 44) return null;       // not found
    if (r.status !== 0) {
      throw new Error(
        `keychain: failed to read ${service}/${account}: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
    // -w prints the password followed by a newline.
    return r.stdout.replace(/\n$/, "");
  }

  async delete(service: string, account: string): Promise<void> {
    const r = this.exec(
      "/usr/bin/security",
      ["delete-generic-password", "-a", account, "-s", service],
    );
    if (r.status !== 0 && r.status !== 44) {
      throw new Error(
        `keychain: failed to delete ${service}/${account}: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
  }
}

/* ── Linux (libsecret) ────────────────────────────────────────── */

export class SecretTool implements SecureStore {
  readonly name = "secret-tool";
  constructor(private exec: Exec = defaultExec) {}

  async put(service: string, account: string, secret: string): Promise<void> {
    const r = this.exec(
      "secret-tool",
      [
        "store",
        "--label=Observer secret",
        "service", service,
        "account", account,
      ],
      { input: secret },
    );
    if (r.status !== 0) {
      throw new Error(
        `secret-tool: failed to store ${service}/${account}: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
  }

  async get(service: string, account: string): Promise<string | null> {
    const r = this.exec("secret-tool", [
      "lookup", "service", service, "account", account,
    ]);
    if (r.status !== 0) return null;
    // secret-tool emits the value with no trailing newline guarantee;
    // strip a single trailing newline if present (some libsecret
    // versions add one).
    return r.stdout.replace(/\n$/, "");
  }

  async delete(service: string, account: string): Promise<void> {
    const r = this.exec("secret-tool", [
      "clear", "service", service, "account", account,
    ]);
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(
        `secret-tool: failed to clear ${service}/${account}: ${r.stderr.trim() || `exit ${r.status}`}`,
      );
    }
  }
}

/* ── No-op fallback ───────────────────────────────────────────── */

/**
 * Returned on platforms where we don't yet support a native keychain
 * (Windows, headless Linux without libsecret). `get` returns null so
 * config resolution falls through to the next source (env, literal);
 * `put` throws so the user knows they need to switch to file/env auth
 * for now rather than silently losing the secret they tried to store.
 */
export class NoOpStore implements SecureStore {
  readonly name = "noop";
  async get(): Promise<string | null> { return null; }
  async delete(): Promise<void> { /* nothing to delete */ }
  async put(): Promise<void> {
    throw new Error(
      `no secure store available on this platform — keychain integration not implemented for ${process.platform}; ` +
      `use apiKey (literal) or apiKeyEnv in the destination config instead`,
    );
  }
}

/**
 * Pick the right backend for this platform, or null if nothing usable
 * is installed. The detection probes for the CLI tool — on a Linux box
 * without libsecret installed, we don't pretend the keyring works.
 */
export function detectSecureStore(exec: Exec = defaultExec): SecureStore | null {
  if (process.platform === "darwin") {
    // /usr/bin/security ships with macOS — present on every Mac.
    return new MacosKeychain(exec);
  }
  if (process.platform === "linux") {
    // secret-tool is part of libsecret-tools; skip if not installed.
    const probe = exec("which", ["secret-tool"]);
    if (probe.status === 0 && probe.stdout.trim() !== "") {
      return new SecretTool(exec);
    }
    return null;
  }
  // Windows: DPAPI access without a third-party dep would require
  // PowerShell or a small native helper; not yet implemented. Return
  // null so callers fall through to file/env auth with a warning.
  return null;
}
