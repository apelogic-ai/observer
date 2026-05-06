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
  getStats, getActivity, getHeatmap, getTokens, getTools, getMotifs, getStumbles, getDarkSpend, getZeroCode,
  getSecurityFindings, getSecurityTimeline, getSecuritySessions, getPermissions,
  getProjects, getModels, getSessions, getProjectList, getModelList, getAgentList, getToolList,
  getToolDetail, getSkills,
  getGitStats, getGitTimeline, getGitCommits, getGitSessions,
  getCommitDetail, getSessionCommits, getSessionSummary, getSessionDetail,
  type Filters,
} from "./queries";
import { getExistingSettings } from "./permissions-existing";

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
  const agent = url.searchParams.get("agent");
  if (agent) f.agent = agent;
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
  "/api/heatmap": async (url) => getHeatmap(filters(url)),
  "/api/tokens": async (url) => getTokens(filters(url)),
  "/api/tools": async (url) => getTools(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 25),
  "/api/motifs": async (url) => getMotifs(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 25),
  "/api/stumbles": async (url) => getStumbles(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/dark-spend": async (url) => getDarkSpend(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/zero-code": async (url) => getZeroCode(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/security/findings": async (url) => getSecurityFindings(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 25),
  "/api/security/timeline": async (url) => getSecurityTimeline(filters(url)),
  "/api/security/sessions": async (url) => getSecuritySessions(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/permissions": async (url) => getPermissions(filters(url)),
  "/api/permissions/existing": async (url) => {
    // No project = nothing to scope to. Returning the user-global file
    // alone would surprise the UI ("why is there content with no
    // project selected?"), so we no-op here.
    const project = url.searchParams.get("project");
    if (!project) return { allow: [], sources: [], repoLocal: null };
    return getExistingSettings(project);
  },
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
  "/api/agent-list": async () => getAgentList(),
  "/api/tool-list": async () => getToolList(),
  "/api/git-stats": async (url) => getGitStats(filters(url)),
  "/api/git-timeline": async (url) => getGitTimeline(filters(url)),
  "/api/git-commits": async (url) => getGitCommits(filters(url), parsePositiveInt(url.searchParams.get("limit")) ?? 50),
  "/api/commit-detail": async (url) => {
    const sha = url.searchParams.get("sha");
    if (!sha) return { error: "sha param required" };
    return getCommitDetail(sha);
  },
  "/api/session-commits": async (url) => {
    const id = url.searchParams.get("id");
    if (!id) return { error: "id param required" };
    return getSessionCommits(id);
  },
  "/api/git-sessions": async (url) => getGitSessions(filters(url)),
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

/**
 * No CORS headers. The dashboard UI is served from the same origin
 * (localhost:3457); browsers send same-origin requests without
 * preflight or `Origin: *` enforcement. The previous wildcard
 * `Access-Control-Allow-Origin: *` allowed any website the user
 * happened to visit to read session prompts and assistant text from
 * `http://localhost:3457/api/*`. Default-deny is the right posture
 * for a local single-user surface.
 */

/** Bun returns BIGINT as JS BigInt — convert to Number for JSON. */
function jsonResponse(data: unknown): Response {
  const body = JSON.stringify(data, (_, v) =>
    typeof v === "bigint" ? Number(v) : v,
  );
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Startup ──────────────────────────────────────────────────────

/**
 * Start the dashboard server. `overrides` are injected on top of whatever
 * argv/env/config.yaml produce — used by the compiled binary to force the
 * staticDir to the extracted-assets path.
 */
export interface StartedServer {
  /** Bun server handle. Has `.stop()` and `.port`. */
  server: ReturnType<typeof Bun.serve>;
  port: number;
}

export async function start(overrides: Partial<CliOverrides> = {}): Promise<StartedServer> {
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

      // Same-origin only: drop preflight handling. Browsers don't send
      // OPTIONS for same-origin requests; if one arrives, treat it as a
      // method-not-allowed.
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 405 });
      }

      const handler = routes[url.pathname];
      const t0 = performance.now();

      // /api/* → JSON handlers; everything else → static assets.
      if (!handler) {
        if (url.pathname.startsWith("/api/")) {
          return Response.json({ error: "not found" }, { status: 404 });
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
        const res = jsonResponse(data);
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
        return Response.json({ error: String(err) }, { status: 500 });
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

  // server.port is typed as number | undefined because Bun.serve in
  // unix-socket mode has no port; with a numeric port (or 0) it's
  // always defined.
  return { server, port: server.port ?? cfg.port };
}

// Script mode: running `bun server/index.ts` directly.
if (import.meta.main) {
  await start();
}
