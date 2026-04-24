/**
 * Public entry point consumed by the `observer` CLI binary.
 *
 * `runDashboard()` is the function `observer dashboard run` invokes. It
 * extracts the embedded static assets, wires the build-info module, and
 * starts the server. Forwards any CLI overrides the caller passes on top
 * of argv parsing inside start().
 */

import { start } from "./index";
import { ensureAssetsExtracted, readEmbeddedBuildInfo } from "./embed";
import { setBuildInfo } from "./build-info";
import type { CliOverrides } from "./config";

export async function runDashboard(overrides: Partial<CliOverrides> = {}): Promise<void> {
  setBuildInfo(readEmbeddedBuildInfo());
  const staticDir = await ensureAssetsExtracted();
  await start({ staticDir, ...overrides });
}
