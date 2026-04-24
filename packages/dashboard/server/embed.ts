/**
 * Asset extractor for the compiled binary.
 *
 * `dist/out.tar` is embedded into the binary via `with { type: "file" }`.
 * At runtime Bun exposes it under `/$bunfs/root/...`. We extract it once to
 * a hash-versioned directory under `~/.observer/dashboard-www/` and return
 * that path for the static handler to serve from.
 *
 * Hash-versioned so binary upgrades ship fresh assets without us having to
 * purge anything — new hash, new dir, old ones can be cleaned manually.
 */

// TS can't resolve `.tar` modules (no wildcard declaration applies to relative
// specifiers under `moduleResolution: "bundler"`). Bun handles it at compile:
// the tarball bytes are embedded and tarPath becomes a /$bunfs/… path.
// @ts-expect-error - .tar has no TS resolution; Bun handles it
import tarPath from "../dist/out.tar" with { type: "file" };
// resolveJsonModule makes TS think this is the parsed object; `with { type:
// "file" }` makes Bun give us a path string at runtime. Cast to reconcile.
import rawBuildInfoPath from "../dist/build-info.json" with { type: "file" };
const buildInfoPath = rawBuildInfoPath as unknown as string;

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BuildInfo } from "./build-info";

let _extracted: string | null = null;

/** Parse the embedded build-info.json (sibling of out.tar in the binary). */
export function readEmbeddedBuildInfo(): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(buildInfoPath, "utf-8")) as BuildInfo;
  } catch {
    return null;
  }
}

export async function ensureAssetsExtracted(): Promise<string> {
  if (_extracted) return _extracted;

  const buf  = await Bun.file(tarPath).arrayBuffer();
  const hash = Bun.hash(buf).toString(16);
  const dest = join(homedir(), ".observer", "dashboard-www", hash);

  // Sentinel: index.html presence means a prior extraction succeeded.
  if (existsSync(join(dest, "index.html"))) {
    _extracted = dest;
    return dest;
  }

  mkdirSync(dest, { recursive: true });
  // System `tar` can't read Bun's /$bunfs/ virtual paths, so we pipe the
  // archive bytes through stdin. `-xf -` tells tar to read from stdin.
  const proc = Bun.spawnSync(["tar", "-xf", "-", "-C", dest], {
    stdin: new Uint8Array(buf),
    stdout: "pipe", stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`failed to extract dashboard assets: ${proc.stderr.toString()}`);
  }

  _extracted = dest;
  return dest;
}
