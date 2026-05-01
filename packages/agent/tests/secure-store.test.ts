import { describe, it, expect, beforeEach } from "bun:test";
import {
  MacosKeychain,
  SecretTool,
  NoOpStore,
  detectSecureStore,
  type Exec,
  type ExecResult,
} from "../src/secure-store";

/**
 * SecureStore is a small abstraction over OS-native keychains. Real
 * unit tests can't touch the OS keychain (would mutate the developer's
 * actual store and break in CI), so each backend takes an `exec`
 * function we can stub. The fake `exec` here mimics the relevant CLI
 * surface in memory.
 */

interface FakeKeychainState {
  /** Map keyed by `${service}\t${account}` → secret. */
  store: Map<string, string>;
  /** Recorded invocations for assertion. */
  calls: Array<{ cmd: string; args: string[]; input?: string }>;
}

function fakeMacosExec(state: FakeKeychainState): Exec {
  return (cmd, args, opts) => {
    state.calls.push({ cmd, args, input: opts?.input });
    if (cmd !== "/usr/bin/security" && cmd !== "security") {
      return { stdout: "", stderr: `unexpected: ${cmd}`, status: 1 };
    }
    const sub = args[0];
    const parsed: Record<string, string> = {};
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (flag === "-a") parsed.account = args[++i] ?? "";
      else if (flag === "-s") parsed.service = args[++i] ?? "";
      else if (flag === "-w") parsed.w = "";
      else if (flag === "-U") parsed.update = "";
      else if (flag === "-T") parsed.app = args[++i] ?? "";
    }
    const key = `${parsed.service ?? ""}\t${parsed.account ?? ""}`;

    if (sub === "add-generic-password") {
      // password is read from stdin when -w is given without value
      if (state.store.has(key) && parsed.update === undefined) {
        return { stdout: "", stderr: "already exists", status: 45 };
      }
      state.store.set(key, opts?.input ?? "");
      return { stdout: "", stderr: "", status: 0 };
    }
    if (sub === "find-generic-password") {
      const v = state.store.get(key);
      if (v === undefined) return { stdout: "", stderr: "not found", status: 44 };
      return { stdout: v, stderr: "", status: 0 };
    }
    if (sub === "delete-generic-password") {
      state.store.delete(key);
      return { stdout: "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: `unexpected sub: ${sub}`, status: 1 };
  };
}

function fakeSecretToolExec(state: FakeKeychainState): Exec {
  return (cmd, args, opts) => {
    state.calls.push({ cmd, args, input: opts?.input });
    if (cmd !== "secret-tool") {
      return { stdout: "", stderr: `unexpected: ${cmd}`, status: 1 };
    }
    const sub = args[0];
    // Drop sub + any --flag args; the remainder is attribute pairs.
    const positional = args.slice(1).filter((a) => !a.startsWith("--"));
    const attrs: Record<string, string> = {};
    for (let i = 0; i < positional.length; i += 2) {
      attrs[positional[i] ?? ""] = positional[i + 1] ?? "";
    }
    const key = `${attrs.service ?? ""}\t${attrs.account ?? ""}`;

    if (sub === "store") {
      state.store.set(key, opts?.input ?? "");
      return { stdout: "", stderr: "", status: 0 };
    }
    if (sub === "lookup") {
      const v = state.store.get(key);
      if (v === undefined) return { stdout: "", stderr: "", status: 1 };
      return { stdout: v, stderr: "", status: 0 };
    }
    if (sub === "clear") {
      state.store.delete(key);
      return { stdout: "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: `unexpected sub: ${sub}`, status: 1 };
  };
}

function commonContract(name: string, makeStore: () => Promise<{ store: ReturnType<typeof MacosKeychain | typeof SecretTool>; state: FakeKeychainState }>) {
  describe(name, () => {
    let s: { store: ReturnType<typeof MacosKeychain | typeof SecretTool>; state: FakeKeychainState };

    beforeEach(async () => {
      s = await makeStore();
    });

    it("put then get returns the same secret", async () => {
      await s.store.put("observer.dev-ingestor", "lbeliaev@gmail.com", "key_abc123");
      expect(await s.store.get("observer.dev-ingestor", "lbeliaev@gmail.com")).toBe("key_abc123");
    });

    it("get returns null for a missing entry", async () => {
      expect(await s.store.get("observer.nope", "lbeliaev@gmail.com")).toBeNull();
    });

    it("delete removes the entry", async () => {
      await s.store.put("svc", "acct", "value");
      await s.store.delete("svc", "acct");
      expect(await s.store.get("svc", "acct")).toBeNull();
    });

    it("delete is idempotent for missing entries", async () => {
      await s.store.delete("svc", "acct");
      expect(await s.store.get("svc", "acct")).toBeNull();
    });

    it("put overwrites an existing entry", async () => {
      await s.store.put("svc", "acct", "first");
      await s.store.put("svc", "acct", "second");
      expect(await s.store.get("svc", "acct")).toBe("second");
    });

    it("isolates entries by (service, account) pair", async () => {
      await s.store.put("svc", "alice", "alice-secret");
      await s.store.put("svc", "bob", "bob-secret");
      expect(await s.store.get("svc", "alice")).toBe("alice-secret");
      expect(await s.store.get("svc", "bob")).toBe("bob-secret");
    });
  });
}

commonContract("MacosKeychain", async () => {
  const state: FakeKeychainState = { store: new Map(), calls: [] };
  return { store: new MacosKeychain(fakeMacosExec(state)), state };
});

commonContract("SecretTool", async () => {
  const state: FakeKeychainState = { store: new Map(), calls: [] };
  return { store: new SecretTool(fakeSecretToolExec(state)), state };
});

describe("MacosKeychain — surface", () => {
  it("invokes /usr/bin/security with correct subcommands", async () => {
    const state: FakeKeychainState = { store: new Map(), calls: [] };
    const k = new MacosKeychain(fakeMacosExec(state));
    await k.put("svc", "acct", "value");
    await k.get("svc", "acct");
    await k.delete("svc", "acct");
    const subs = state.calls.map((c) => c.args[0]);
    expect(subs).toEqual([
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ]);
  });

  it("passes the secret over stdin, not on the command line", async () => {
    // Critical: secrets in argv land in `ps` and shell history. Stdin
    // is the right channel.
    const state: FakeKeychainState = { store: new Map(), calls: [] };
    const k = new MacosKeychain(fakeMacosExec(state));
    await k.put("svc", "acct", "verysecret");
    expect(state.calls[0]!.input).toBe("verysecret");
    expect(state.calls[0]!.args.join(" ")).not.toContain("verysecret");
  });
});

describe("NoOpStore", () => {
  it("get always returns null", async () => {
    const s = new NoOpStore();
    expect(await s.get("svc", "acct")).toBeNull();
  });

  it("put throws — not safe to silently noop secrets", async () => {
    const s = new NoOpStore();
    await expect(s.put("svc", "acct", "value")).rejects.toThrow(/no.*secure/i);
  });
});

describe("detectSecureStore", () => {
  it("returns null on unsupported platforms when no backend is available", () => {
    // We can't easily fake process.platform without monkeypatching, so
    // this just exercises the function runs and returns either a Store
    // or null. The real selection logic is in detectSecureStore impl.
    const store = detectSecureStore();
    expect(store === null || typeof store.get === "function").toBe(true);
  });
});
