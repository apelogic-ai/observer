#!/usr/bin/env bun
/**
 * Observer Dashboard API — standalone Bun server backed by DuckDB.
 *
 * Config resolution lives in ./config; see --help for flags.
 */

import { initDb, getDataDir, getDbStats, rebuild } from "./db";
import { closeLog, getLogSettings, initLog, log, memSnapshot } from "./log";
import { loadDashboardConfig, parseCliArgs, type CliOverrides } from "./config";
import { getBuildInfo } from "./build-info";
import { createStaticHandler } from "./static";
import {
  getStats, getActivity, getTokens, getTools,
  getProjects, getModels, getSessions, getProjectList, getModelList,
  getToolDetail, getSkills,
  getGitStats, getGitTimeline, getGitCommits,
  getCommitDetail, getSessionSummary, getSessionDetail,
  type Filters,
} from "./queries";

/** Extract common filters from query params. Unparseable values are dropped
 *  rather than passed through — prevents `NaN` from flowing into SQL
 *  (`INTERVAL 'NaN days'` produces useless errors). */
function filters(url: URL): Filters {
  const f: Filters = {};
  const days = parsePositiveInt(url.searchParams.get("days"));
  if (days !== null) f.days = days;
  const project = url.searchParams.get("project");
  if (project) f.project = project;
  const model = url.searchParams.get("model");
  if (model) f.model = model;
  const tool = url.searchParams.get("tool");
  if (tool) f.tool = tool;
  const granularity = url.searchParams.get("granularity");
  if (granularity === "week" || granularity === "month") f.granularity = granularity;
  return f;
}

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type Handler = (url: URL) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "/api/stats": async (url) => getStats(filters(url)),
  "/api/activity": async (url) => getActivity(filters(url)),
  "/api/tokens": async (url) => getTokens(filters(url)),
  "/api/tools": async (url) => getTools(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 25),
  "/api/projects": async (url) => getProjects(filters(url)),
  "/api/models": async (url) => getModels(filters(url)),
  "/api/sessions": async (url) => getSessions(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/tool-detail": async (url) => {
    const tool = url.searchParams.get("tool");
    if (!tool) return { error: "tool param required" };
    return getToolDetail(tool, filters(url));
  },
  "/api/skills": async (url) => getSkills(filters(url)),
  "/api/project-list": async () => getProjectList(),
  "/api/model-list": async () => getModelList(),
  "/api/git-stats": async (url) => getGitStats(filters(url)),
  "/api/git-timeline": async (url) => getGitTimeline(filters(url)),
  "/api/git-commits": async (url) => getGitCommits(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/commit-detail": async (url) => {
    const sha = url.searchParams.get("sha");
    if (!sha) return { error: "sha param required" };
    return getCommitDetail(sha);
  },
  "/api/session-summary": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) return { error: "id param required" };
    return getSessionSummary(id);
  },
  "/api/session-detail": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) return { error: "id param required" };
    return getSessionDetail(id);
  },
  "/api/refresh": async () => {
    await rebuild("api");
    return { ok: true, ...getDbStats() };
  },
  "/api/diag": async () => ({
    ...getDbStats(),
    ...memSnapshot(),
    data_dir: getDataDir(),
    uptime_s: Math.round(process.uptime()),
    log: getLogSettings(),
    build: getBuildInfo(),
  }),
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** DuckDB returns BIGINT as JS BigInt — convert to Number for JSON. */
function jsonResponse(data: unknown, headers: Record<string, string>): Response {
  const body = JSON.stringify(data, (_, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
  return new Response(body, {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ── Startup ──────────────────────────────────────────────────────

/**
 * Start the dashboard server. `overrides` are injected on top of whatever
 * argv/env/config.yaml produce — used by the compiled binary to force the
 * staticDir to the extracted-assets path.
 */
export async function start(overrides: Partial<CliOverrides> = {}): Promise<void> {
  // overrides are defaults injected by callers (e.g. compiled-entry passes
  // staticDir from the extracted tarball). argv still wins so the user can
  // --static-dir a local out/ for debugging.
  const cfg = loadDashboardConfig({ ...overrides, ...parseCliArgs(process.argv.slice(2)) });
  initLog(cfg.log);

  await initDb(cfg.dataDir);

  const serveStatic = createStaticHandler(cfg.staticDir);

  // URL display: when bound to localhost loopback, show the friendly form;
  // when exposed (0.0.0.0 or specific iface), show the actual bind so the
  // user understands the surface area.
  const isLoopback = cfg.bind === "127.0.0.1" || cfg.bind === "localhost" || cfg.bind === "::1";
  const displayHost = isLoopback ? "localhost" : cfg.bind;
  console.log(`Observer Dashboard`);
  console.log(`  Data:   ${getDataDir()}`);
  console.log(`  Static: ${cfg.staticDir}`);
  console.log(`  URL:    http://${displayHost}:${cfg.port}${isLoopback ? "" : "  (LAN-exposed; no auth)"}`);
  console.log(`  Config: ${cfg.configPath}`);
  console.log(`  Logs:   ${cfg.log.level === "silent" ? "off" : cfg.log.file} (level=${cfg.log.level}${cfg.log.stderr ? ", stderr=on" : ""})`);

  // Periodic memory snapshot — lets us tell whether a future freeze is driven
  // by the API server or something else. 60s is often enough to catch a climb.
  const MEM_LOG_INTERVAL_MS = 60_000;
  const memTimer = setInterval(() => {
    log("proc.mem", { ...memSnapshot(), ...getDbStats() });
  }, MEM_LOG_INTERVAL_MS);
  memTimer.unref?.();

  log("server.start", { port: cfg.port, data_dir: getDataDir(), ...getDbStats(), ...memSnapshot() });

  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.bind,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      const handler = routes[url.pathname];
      const t0 = performance.now();

      // /api/* → JSON handlers; everything else → static assets.
      if (!handler) {
        if (url.pathname.startsWith("/api/")) {
          return Response.json({ error: "not found" }, { status: 404, headers: CORS });
        }
        try {
          const res = await serveStatic(url.pathname);
          log("http", {
            path: url.pathname,
            ms: Math.round(performance.now() - t0),
            status: res.status,
            static: true,
          });
          return res;
        } catch (err) {
          log("http.error", {
            path: url.pathname,
            ms: Math.round(performance.now() - t0),
            status: 500,
            err: String(err),
            static: true,
          });
          return new Response("internal error", { status: 500 });
        }
      }

      try {
        const data = await handler(url);
        const res = jsonResponse(data, CORS);
        log("http", {
          path: url.pathname,
          q: url.search || undefined,
          ms: Math.round(performance.now() - t0),
          status: 200,
        });
        return res;
      } catch (err) {
        log("http.error", {
          path: url.pathname,
          ms: Math.round(performance.now() - t0),
          status: 500,
          err: String(err),
        });
        return Response.json({ error: String(err) }, { status: 500, headers: CORS });
      }
    },
  });

  // Clean shutdown — flush logs, stop the server, let Bun exit. Without this
  // SIGINT/SIGTERM kills the process mid-write and log lines are truncated.
  async function shutdown(signal: string): Promise<void> {
    log("server.stop", { signal });
    clearInterval(memTimer);
    try { await server.stop(); } catch { /* ignore */ }
    closeLog();
    process.exit(0);
  }
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

// Script mode: running `bun server/index.ts` directly.
if (import.meta.main) {
  await start();
}
