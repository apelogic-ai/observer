import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression tests for the 2026-05 security review. These don't
 * exercise behaviour — they static-grep the source for patterns
 * the review flagged as exploitable, so a future commit that
 * reintroduces them fails CI loudly.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

describe("OBS-003: OBSERVER_REPO env override removed", () => {
  // The agent's update path used to honour an OBSERVER_REPO env var,
  // letting a single line in a shell rc / CI env flip the next
  // observer-self-update to fetch from an attacker-controlled fork.
  // The fix is to hardcode the repo; this test fails if anyone
  // re-introduces the lookup.
  it("packages/agent/src/cli.ts does not read OBSERVER_REPO from env", () => {
    const src = read("packages/agent/src/cli.ts");
    expect(src).not.toMatch(/process\.env\.OBSERVER_REPO/);
  });

  it("install.sh does not read OBSERVER_REPO from env", () => {
    const src = read("install.sh");
    // Match `${OBSERVER_REPO` or `$OBSERVER_REPO` as a parameter
    // expansion. Doc-comment mentions are fine (and currently
    // absent), so we look for the actual expansion syntax.
    expect(src).not.toMatch(/\$\{?OBSERVER_REPO\b/);
  });
});

describe("OBS-006: API server refuses to start without OBSERVER_API_KEYS", () => {
  // The fallback to a hardcoded "key_local_dev" Bearer token used to
  // kick in whenever NODE_ENV wasn't set, which meant a bare
  // `docker run` or misconfigured Kubernetes pod got a publicly-
  // known credential. main.ts now requires OBSERVER_API_KEYS
  // regardless of NODE_ENV.
  it("packages/api/src/main.ts has no `?? ['key_local_dev']` fallback line", () => {
    // The bug used to look like `const apiKeys = ... ?? ["key_local_dev"]`.
    // Comments about the historical fallback are fine; an actual
    // expression that defaults to it is not.
    const src = read("packages/api/src/main.ts");
    expect(src).not.toMatch(/\[\s*['"]key_local_dev['"]\s*\]/);
  });

  it("packages/api/Dockerfile sets NODE_ENV=production", () => {
    const src = read("packages/api/Dockerfile");
    expect(src).toMatch(/ENV NODE_ENV=production/);
  });
});

describe("OBS-004: API key entries bind to a developer identity", () => {
  // Each entry of OBSERVER_API_KEYS must be `<developer>:<key>`.
  // The startup parser refuses entries without a colon prefix; a
  // single tenant per key is the contract that downstream
  // tenant-binding enforcement relies on.
  it("main.ts parses developer:key pairs (not plain keys)", () => {
    const src = read("packages/api/src/main.ts");
    expect(src).toMatch(/developer.*prefix/);
  });
});

describe("OBS-001: install.sh fails closed on checksum-fetch failure", () => {
  // If `curl` for the .sha256 returns non-zero, install.sh must
  // refuse to install. Earlier versions silently fell through and
  // installed the unverified binary.
  it("install.sh treats checksum-fetch failure as fatal", () => {
    const src = read("install.sh");
    // The fix replaces an `if curl ... ; then ... fi` (silent-pass)
    // pattern with `if ! curl ... ; then error ... fi`. Assert
    // that the negated form exists adjacent to the checksum URL.
    const checksumBlock = src.match(/^[^\n]*"\$checksum_url"[^\n]*/m);
    expect(checksumBlock).not.toBeNull();
    expect(checksumBlock![0]).toContain("! curl");
  });
});

describe("OBS-002: release artifacts are signed with sigstore cosign", () => {
  // Producer side. The release workflow signs every binary with
  // keyless cosign (OIDC from GitHub Actions) and publishes the
  // resulting `.bundle` alongside the binary. A future commit that
  // strips the signing step should fail this test loudly.
  it(".github/workflows/release.yml installs cosign", () => {
    const src = read(".github/workflows/release.yml");
    expect(src).toMatch(/sigstore\/cosign-installer/);
  });

  it(".github/workflows/release.yml signs every binary with cosign sign-blob", () => {
    const src = read(".github/workflows/release.yml");
    expect(src).toMatch(/cosign sign-blob/);
  });

  it(".github/workflows/release.yml grants id-token: write for OIDC keyless signing", () => {
    const src = read(".github/workflows/release.yml");
    // Either at job level or at top-level permissions. The build
    // matrix mints the OIDC token, so it must have id-token:write.
    expect(src).toMatch(/id-token:\s*write/);
  });

  it(".github/workflows/release.yml publishes the .bundle alongside each binary", () => {
    const src = read(".github/workflows/release.yml");
    expect(src).toMatch(/\.bundle/);
  });
});

describe("OBS-002 (consumer side): install.sh and updater verify signatures when cosign is available", () => {
  it("install.sh checks for cosign and runs cosign verify-blob", () => {
    const src = read("install.sh");
    expect(src).toMatch(/cosign verify-blob/);
  });

  it("install.sh honours OBSERVER_REQUIRE_SIGNATURE for strict mode", () => {
    const src = read("install.sh");
    expect(src).toMatch(/OBSERVER_REQUIRE_SIGNATURE/);
  });

  it("packages/agent/src/cli.ts updater verifies the bundle with cosign when available", () => {
    const src = read("packages/agent/src/cli.ts");
    expect(src).toMatch(/cosign/);
    expect(src).toMatch(/OBSERVER_REQUIRE_SIGNATURE/);
  });
});

describe("OBS-018: doc cleanup — observer.dev/api/latest-version is not in the shipped docs", () => {
  // The assessment flagged that docs/product.md described an
  // observer.dev/api/latest-version endpoint that the agent never
  // actually called. Stale doc → confusion about threat model.
  it("docs/product.md does not describe a GET observer.dev/api/latest-version flow", () => {
    const src = read("docs/product.md");
    expect(src).not.toMatch(/observer\.dev\/api\/latest-version/);
  });

  it("docs/product.md and README.md route installs through the canonical GitHub URL", () => {
    const product = read("docs/product.md");
    const readme = read("README.md");
    // Neither file should still publish https://observer.dev/install.sh,
    // which currently 404s and is a perfect domain-takeover hook.
    expect(product).not.toMatch(/observer\.dev\/install\.sh/);
    expect(readme).not.toMatch(/observer\.dev\/install\.sh/);
  });
});
