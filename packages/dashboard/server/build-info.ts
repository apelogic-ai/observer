/**
 * Build provenance — a blob written by scripts/bundle-static.ts and embedded
 * into the compiled binary alongside the tarball. Surfaced via /api/diag so
 * you can verify "what source was this binary built from".
 *
 * Populated by compiled-entry.ts at startup in the shipped binary.
 * Remains null when the server runs from source (no embedded info).
 */

export interface BuildInfo {
  sourceHash: string;
  builtAt: string;
  tarSize: number;
  fileCount: number;
}

let _info: BuildInfo | null = null;

export function setBuildInfo(info: BuildInfo | null): void {
  _info = info;
}

export function getBuildInfo(): BuildInfo | null {
  return _info;
}
