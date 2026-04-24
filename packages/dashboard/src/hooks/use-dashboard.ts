"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  Stats, ActivityRow, TokenRow, ToolRow, ProjectRow, ModelRow,
  SessionRow, SkillRow, ToolDetail,
  GitStats, GitTimelineRow, GitCommitRow,
} from "@/lib/queries";

export interface DashboardData {
  stats: Stats;
  activity: ActivityRow[];
  tokens: TokenRow[];
  tools: ToolRow[];
  projects: ProjectRow[];
  models: ModelRow[];
  sessions: SessionRow[];
  skills: SkillRow[];
}

export interface DashboardFilters {
  days: number | null;
  project: string | null;
  granularity?: string;
  model?: string | null;
  tool?: string | null;
}

function buildParams(f: DashboardFilters, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (f.days) p.set("days", String(f.days));
  if (f.project) p.set("project", f.project);
  if (f.granularity && f.granularity !== "day") p.set("granularity", f.granularity);
  if (f.model) p.set("model", f.model);
  if (f.tool) p.set("tool", f.tool);
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return r.json();
}

// All fetch hooks follow the same shape: fetch inside a useEffect with a
// cancelled flag; expose a `refresh` that bumps a tick to re-trigger the
// effect. setState only fires inside .then/.catch (async) — not synchronously
// in the effect body — which satisfies React 19's set-state-in-effect rule.

export function useDashboard(filters: DashboardFilters) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Destructure primitives so exhaustive-deps is satisfied without the
  // whole filters object being a dep.
  const { days, project, granularity, model, tool } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, granularity, model, tool });

    Promise.all([
      fetchJson<Stats>(`/api/stats${params}`),
      fetchJson<ActivityRow[]>(`/api/activity${params}`),
      fetchJson<TokenRow[]>(`/api/tokens${params}`),
      fetchJson<ToolRow[]>(`/api/tools${params}`),
      fetchJson<ProjectRow[]>(`/api/projects${params}`),
      fetchJson<ModelRow[]>(`/api/models${params}`),
      fetchJson<SessionRow[]>(`/api/sessions${params}`),
      fetchJson<SkillRow[]>(`/api/skills${params}`),
    ])
      .then(([stats, activity, tokens, tools, projects, models, sessions, skills]) => {
        if (cancelled) return;
        setData({ stats, activity, tokens, tools, projects, models, sessions, skills });
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [days, project, granularity, model, tool, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

export function useProjectList() {
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/project-list")
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setProjects(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return projects;
}

export function useModelList() {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/model-list")
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setModels(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return models;
}

export interface GitData {
  stats: GitStats;
  timeline: GitTimelineRow[];
  commits: GitCommitRow[];
}

export function useGitData(filters: DashboardFilters) {
  const [data, setData] = useState<GitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const { days, project, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, granularity });

    Promise.all([
      fetchJson<GitStats>(`/api/git-stats${params}`),
      fetchJson<GitTimelineRow[]>(`/api/git-timeline${params}`),
      fetchJson<GitCommitRow[]>(`/api/git-commits${params}`),
    ])
      .then(([stats, timeline, commits]) => {
        if (cancelled) return;
        setData({ stats, timeline, commits });
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [days, project, granularity, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

export function useToolDetail(tool: string | null, filters: DashboardFilters) {
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(tool));

  const { days, project, granularity } = filters;

  useEffect(() => {
    if (!tool) return;
    let cancelled = false;
    const params = buildParams({ days, project, granularity }, { tool });
    fetchJson<ToolDetail>(`/api/tool-detail${params}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tool, days, project, granularity]);

  return { detail, loading };
}
