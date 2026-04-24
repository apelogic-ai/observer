/**
 * Structured logger. Writes `ISO  event  {json}` lines — human-readable in
 * `tail -f` and greppable/jq-able.
 *
 * Configuration is passed in via initLog() at startup (from loadDashboardConfig)
 * rather than read from env at import time, so the same precedence rules
 * (CLI > env > config file > defaults) apply uniformly.
 *
 * Events are classified automatically:
 *   debug  - http, proc.mem        (per-request + periodic memory)
 *   info   - server.start, db.*    (lifecycle)
 *   error  - *.error               (any event name ending in .error)
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "silent" | "error" | "info" | "debug";

export interface LogSettings {
  level: LogLevel;
  file: string;         // resolved path (empty string if silent)
  stderr: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0, error: 1, info: 2, debug: 3,
};

const MAX_LOG_BYTES = 10 * 1024 * 1024; // rotate at 10 MB — keeps one .old sibling

let _settings: LogSettings = { level: "info", file: "", stderr: false };
let _stream: WriteStream | null = null;
let _streamFailed = false;

export function initLog(settings: LogSettings): void {
  _settings = settings;
  // Reset stream — re-open lazily on next write.
  if (_stream) { try { _stream.end(); } catch { /* ignore */ } }
  _stream = null;
  _streamFailed = false;
}

export function getLogSettings(): LogSettings {
  return { ..._settings };
}

function classify(event: string): LogLevel {
  if (event.endsWith(".error")) return "error";
  if (event === "http" || event === "proc.mem") return "debug";
  return "info";
}

function getStream(): WriteStream | null {
  if (_stream || _streamFailed) return _stream;
  if (_settings.level === "silent" || !_settings.file) return null;
  try {
    mkdirSync(dirname(_settings.file), { recursive: true });
    // One-shot rotation at startup if the file is already oversized.
    try {
      if (existsSync(_settings.file) && statSync(_settings.file).size > MAX_LOG_BYTES) {
        renameSync(_settings.file, `${_settings.file}.old`);
      }
    } catch { /* non-fatal — keep appending */ }

    _stream = createWriteStream(_settings.file, { flags: "a" });
    _stream.on("error", () => { _stream = null; _streamFailed = true; });
  } catch {
    _streamFailed = true;
  }
  return _stream;
}

export function log(event: string, data?: Record<string, unknown>): void {
  const eventLevel = classify(event);
  if (LEVEL_ORDER[eventLevel] > LEVEL_ORDER[_settings.level]) return;

  const ts = new Date().toISOString();
  const line = data === undefined
    ? `${ts}  ${event}\n`
    : `${ts}  ${event}  ${JSON.stringify(data)}\n`;

  const s = getStream();
  if (s) {
    try { s.write(line); } catch { /* stream error handler will disable further writes */ }
  }
  if (_settings.stderr) process.stderr.write(line);
}

/** Snapshot of Node/Bun process memory, rounded to MB for log readability. */
export function memSnapshot(): Record<string, number> {
  const m = process.memoryUsage();
  return {
    rss_mb: Math.round(m.rss / 1024 / 1024),
    heap_mb: Math.round(m.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(m.heapTotal / 1024 / 1024),
    external_mb: Math.round(m.external / 1024 / 1024),
    array_buffers_mb: Math.round((m.arrayBuffers ?? 0) / 1024 / 1024),
  };
}

export function closeLog(): void {
  if (_stream) {
    try { _stream.end(); } catch { /* ignore */ }
    _stream = null;
  }
}
