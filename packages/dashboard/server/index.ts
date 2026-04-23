#!/usr/bin/env bun
/**
 * Observer Dashboard API — standalone Bun server backed by DuckDB.
 *
 * Usage:
 *   bun server/index.ts [--port 3457] [--data-dir ~/.observer/traces/normalized]
 */

import { initDb, getDataDir } from "./db";
import {
  getStats, getActivity, getTokens, getTools,
  getProjects, getModels, getSessions, getProjectList, getModelList,
  getToolDetail, getSkills,
  getGitStats, getGitTimeline, getGitCommits,
  getCommitDetail, getSessionSummary, getSessionDetail,
  type Filters,
} from "./queries";

function parseArgs(): { port: number; dataDir?: string } {
  const args = process.argv.slice(2);
  let port = 3457;
  let dataDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = parseInt(args[i + 1], 10);
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = args[i + 1];
  }
  return { port, dataDir };
}

/** Extract common filters from query params. */
function filters(url: URL): Filters {
  const f: Filters = {};
  const days = url.searchParams.get("days");
  if (days) f.days = parseInt(days, 10);
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

type Handler = (url: URL) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "/api/stats": async (url) => getStats(filters(url)),
  "/api/activity": async (url) => getActivity(filters(url)),
  "/api/tokens": async (url) => getTokens(filters(url)),
  "/api/tools": async (url) => {
    const limit = url.searchParams.get("limit");
    return getTools(filters(url), limit ? parseInt(limit, 10) : 25);
  },
  "/api/projects": async (url) => getProjects(filters(url)),
  "/api/models": async (url) => getModels(filters(url)),
  "/api/sessions": async (url) => {
    const limit = url.searchParams.get("limit");
    return getSessions(filters(url), limit ? parseInt(limit, 10) : 50);
  },
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
  "/api/git-commits": async (url) => {
    const limit = url.searchParams.get("limit");
    return getGitCommits(filters(url), limit ? parseInt(limit, 10) : 50);
  },
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

const { port, dataDir } = parseArgs();
await initDb(dataDir);

console.log(`Observer API server`);
console.log(`  Data: ${getDataDir()}`);
console.log(`  URL:  http://localhost:${port}`);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const handler = routes[url.pathname];
    if (!handler) {
      return Response.json({ error: "not found" }, { status: 404, headers: CORS });
    }

    try {
      const data = await handler(url);
      return jsonResponse(data, CORS);
    } catch (err) {
      console.error(`Error: ${url.pathname}`, err);
      return Response.json({ error: String(err) }, { status: 500, headers: CORS });
    }
  },
});
