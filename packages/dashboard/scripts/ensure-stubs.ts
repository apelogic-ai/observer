#!/usr/bin/env bun
/**
 * Ensure `dist/out.tar` and `dist/build-info.json` exist so that typecheck
 * passes on a clean tree (before `next build` has run). The real contents
 * are written by scripts/bundle-static.ts; these stubs are overwritten on
 * build and never end up in a shipped binary.
 *
 * Exists because server/embed.ts does `import … from "…" with { type: "file" }`
 * — TS needs the files on disk even though it casts them to string.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dir, "..", "dist");
mkdirSync(dist, { recursive: true });

const tar = resolve(dist, "out.tar");
if (!existsSync(tar)) writeFileSync(tar, "");

const info = resolve(dist, "build-info.json");
if (!existsSync(info)) {
  writeFileSync(info, JSON.stringify({
    sourceHash: "", builtAt: "", tarSize: 0, fileCount: 0,
  }) + "\n");
}
