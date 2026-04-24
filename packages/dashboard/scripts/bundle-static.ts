#!/usr/bin/env bun
/**
 * Package `out/` (produced by `next build`) into `dist/out.tar` so it can be
 * embedded into the compiled binary via `import … with { type: "file" }`.
 *
 * Run after `next build` and before `bun build --compile`.
 *
 * Fails fast if any file in the UI source tree is newer than out/index.html —
 * this catches the footgun where someone edits src/ and compiles without
 * re-running next build, shipping a stale UI inside the binary.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const outDir = resolve(pkgDir, "out");
const dist   = resolve(pkgDir, "dist");
const tar    = resolve(dist, "out.tar");
const info   = resolve(dist, "build-info.json");

// Source roots that feed the UI build. If any file in here is newer than
// out/index.html, the Next build output is stale relative to the source tree.
const SOURCE_ROOTS = ["src", "server", "public"].map((r) => resolve(pkgDir, r));
const SOURCE_FILES = [
  resolve(pkgDir, "next.config.ts"),
  resolve(pkgDir, "package.json"),
  resolve(pkgDir, "tsconfig.json"),
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const sourceFiles = [
  ...SOURCE_ROOTS.flatMap(walk),
  ...SOURCE_FILES.filter((f) => existsSync(f)),
].sort();

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  console.error(`bundle-static: missing ${outDir} — run \`next build\` first.`);
  process.exit(1);
}

const outIndex = resolve(outDir, "index.html");
if (!existsSync(outIndex)) {
  console.error(`bundle-static: ${outIndex} missing — run \`next build\` first.`);
  process.exit(1);
}

const outBuiltAt = statSync(outIndex).mtimeMs;

// Staleness check — any source file newer than out/index.html means the Next
// build output doesn't match the current source tree.
const stale = sourceFiles
  .map((f) => ({ path: f, mtime: statSync(f).mtimeMs }))
  .filter((e) => e.mtime > outBuiltAt);

if (stale.length > 0) {
  console.error(`bundle-static: ${stale.length} source file(s) newer than out/ — Next build is stale.`);
  for (const e of stale.slice(0, 5)) {
    console.error(`  - ${relative(pkgDir, e.path)}`);
  }
  if (stale.length > 5) console.error(`  - … and ${stale.length - 5} more`);
  console.error(`Run \`next build\` to refresh, then re-run this script.`);
  process.exit(1);
}

// Source hash — sha256 over (relpath, null, bytes, null) for each file.
// Lets us surface provenance at runtime and catch "binary built from unknown source".
const hasher = createHash("sha256");
for (const f of sourceFiles) {
  hasher.update(relative(pkgDir, f));
  hasher.update("\0");
  hasher.update(readFileSync(f));
  hasher.update("\0");
}
const sourceHash = hasher.digest("hex");

mkdirSync(dirname(tar), { recursive: true });

// `-C` avoids a leading `out/` in archive paths — extract anywhere, serve from there.
const proc = Bun.spawnSync(["tar", "-cf", tar, "-C", outDir, "."]);
if (proc.exitCode !== 0) {
  console.error("bundle-static: tar failed");
  process.stderr.write(proc.stderr);
  process.exit(proc.exitCode ?? 1);
}

const tarSize = statSync(tar).size;

writeFileSync(info, JSON.stringify({
  sourceHash,
  builtAt: new Date().toISOString(),
  tarSize,
  fileCount: sourceFiles.length,
}, null, 2) + "\n");

console.log(`bundle-static: wrote ${tar} (${(tarSize / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  sources: ${sourceFiles.length} files, hash=${sourceHash.slice(0, 12)}…`);
