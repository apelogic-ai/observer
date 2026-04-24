#!/usr/bin/env bun
/**
 * Release — cut a tagged release from master.
 *
 * Usage:
 *   bun scripts/release.ts <version>           # interactive
 *   bun scripts/release.ts <version> --yes     # skip the confirmation prompt
 *   bun scripts/release.ts <version> --skip-tests   # skip local typecheck/test/build
 *   bun scripts/release.ts <version> --dry-run      # run all checks, don't commit/tag/push
 *
 * What it does:
 *   1. Verify branch is master/main, tree is clean, in sync with origin.
 *   2. Verify tag vX.Y.Z does not already exist.
 *   3. Run local typecheck + tests + dashboard build + compile smoke.
 *      (These are the same things CI does, so a green local run = a green CI.)
 *   4. Bump packages/agent/package.json version (if it differs).
 *   5. Commit "release: vX.Y.Z", tag, push branch + tag.
 *   6. Print the Actions URL — CI takes over from there.
 *
 * Rollback if something ships broken:
 *   gh release delete vX.Y.Z
 *   git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
 */

import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [, , versionArg, ...flags] = process.argv;
const skipConfirm = flags.includes("--yes") || flags.includes("-y");
const skipTests   = flags.includes("--skip-tests");
const dryRun      = flags.includes("--dry-run");

if (!versionArg || versionArg.startsWith("-")) {
  console.error("Usage: bun scripts/release.ts <version> [--yes] [--skip-tests] [--dry-run]");
  console.error("  e.g.: bun scripts/release.ts 0.1.0");
  process.exit(1);
}

// Accept "v0.1.0" or "0.1.0"; store canonical without v.
const version = versionArg.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(version)) {
  console.error(`Invalid version: "${versionArg}". Expected semver like 0.1.0 or 0.1.0-beta.1.`);
  process.exit(1);
}

const tag = `v${version}`;
const repoRoot = resolve(import.meta.dir, "..");

function run(cmd: string, opts: { cwd?: string } = {}): void {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: opts.cwd ?? repoRoot, stdio: "inherit" });
}

function capture(cmd: string, opts: { cwd?: string } = {}): string {
  return execSync(cmd, {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryCapture(cmd: string): string | null {
  try { return capture(cmd); }
  catch { return null; }
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

console.log(`Release ${tag}${dryRun ? " (DRY RUN)" : ""}`);

// ── Git state ──────────────────────────────────────────────────────

section("Git state");

const branch = capture("git rev-parse --abbrev-ref HEAD");
if (branch !== "master" && branch !== "main") {
  fail(`Must be on master or main (currently: ${branch}).`);
}

const dirty = capture("git status --porcelain");
if (dirty) {
  fail(`Working tree is dirty. Commit or stash first:\n${dirty}`);
}

if (tryCapture(`git rev-parse --verify --quiet refs/tags/${tag}`)) {
  fail(`Tag ${tag} already exists locally. Delete with \`git tag -d ${tag}\` or pick a new version.`);
}

console.log("Fetching origin…");
run("git fetch origin --tags --quiet");

if (tryCapture(`git rev-parse --verify --quiet refs/tags/${tag}`)) {
  fail(`Tag ${tag} already exists on origin. Pick a new version, or delete it first.`);
}

const localHead  = capture("git rev-parse HEAD");
const remoteHead = capture(`git rev-parse origin/${branch}`);
if (localHead !== remoteHead) {
  const ahead  = capture(`git rev-list --count origin/${branch}..HEAD`);
  const behind = capture(`git rev-list --count HEAD..origin/${branch}`);
  fail(`Out of sync with origin/${branch} (ahead: ${ahead}, behind: ${behind}). Push or pull first.`);
}

console.log(`  ✓ on ${branch}, clean, synced with origin`);

// ── Pre-flight builds ──────────────────────────────────────────────

if (!skipTests) {
  section("Typecheck");
  run("bun run typecheck", { cwd: resolve(repoRoot, "packages/agent") });
  run("bun run typecheck", { cwd: resolve(repoRoot, "packages/dashboard") });

  section("Tests");
  run("bun run test", { cwd: resolve(repoRoot, "packages/agent") });

  section("Dashboard build");
  run("bun run build", { cwd: resolve(repoRoot, "packages/dashboard") });

  section("Binary compile smoke");
  const smokeBin = "/tmp/observer-release-smoke";
  run(`bun build --compile src/cli.ts --outfile ${smokeBin}`, {
    cwd: resolve(repoRoot, "packages/agent"),
  });
  run(`chmod +x ${smokeBin} && ${smokeBin} --version`);
  run(`${smokeBin} dashboard --help | head -3`);
  run(`rm -f ${smokeBin}`);
  console.log("  ✓ binary compiles and embeds dashboard");
} else {
  console.log("\n(skipping typecheck/tests/build — --skip-tests)");
}

// ── Version bump ───────────────────────────────────────────────────

section("Version");

const pkgPath = resolve(repoRoot, "packages/agent/package.json");
const pkgRaw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw) as { version: string };
const currentVersion = pkg.version;
let bumped = false;

if (currentVersion === version) {
  console.log(`  ✓ packages/agent already at ${version}`);
} else {
  console.log(`  ${currentVersion} → ${version}`);
  pkg.version = version;
  if (!dryRun) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  bumped = true;
}

// ── Confirm ────────────────────────────────────────────────────────

if (!skipConfirm && !dryRun) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    rl.question(`\nCommit (if bumped), tag ${tag}, and push to origin? [y/N] `, res);
  });
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    if (bumped) {
      writeFileSync(pkgPath, pkgRaw); // revert in-place
      console.log("Reverted version bump.");
    }
    console.log("Aborted.");
    process.exit(1);
  }
}

if (dryRun) {
  console.log("\n(dry run — would commit, tag, and push here)");
  if (bumped) {
    writeFileSync(pkgPath, pkgRaw);
    console.log("Reverted in-memory version bump.");
  }
  process.exit(0);
}

// ── Commit + tag + push ────────────────────────────────────────────

section("Release");

if (bumped) {
  run(`git add "${pkgPath}"`);
  run(`git commit -m "release: ${tag}"`);
}

run(`git tag -a ${tag} -m "Release ${tag}"`);
run(`git push origin ${branch}`);
run(`git push origin ${tag}`);

// ── Summary ────────────────────────────────────────────────────────

const remote = capture("git remote get-url origin")
  .replace(/\.git$/, "")
  .replace(/^git@github\.com:/, "https://github.com/");

console.log(`\n✓ Released ${tag}`);
console.log(`  Release page: ${remote}/releases/tag/${tag}`);
console.log(`  CI run:       ${remote}/actions`);
console.log(`\n  CI will now build binaries and create the release artifact.`);
console.log(`  Watch:        gh run watch`);
