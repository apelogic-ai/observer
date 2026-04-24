#!/usr/bin/env bun
/**
 * Entry point for a standalone compiled `observer-dashboard` binary
 * (built by `bun run compile` in this package). The main observer binary
 * reaches `runDashboard` via the workspace export instead.
 */

import { runDashboard } from "./runtime";
await runDashboard();
