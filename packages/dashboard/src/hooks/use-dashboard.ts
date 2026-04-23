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

export function useDashboard(filters: DashboardFilters) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = buildParams(filters);

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
        setData({ stats, activity, tokens, tools, projects, models, sessions, skills });
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [filters.days, filters.project, filters.granularity, filters.model, filters.tool]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useProjectList() {
  const [projects, setProjects] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/project-list")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setProjects(data); })
      .catch(() => {});
  }, []);

  return projects;
}

export function useModelList() {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/model-list")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setModels(data); })
      .catch(() => {});
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

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = buildParams(filters);

    Promise.all([
      fetchJson<GitStats>(`/api/git-stats${params}`),
      fetchJson<GitTimelineRow[]>(`/api/git-timeline${params}`),
      fetchJson<GitCommitRow[]>(`/api/git-commits${params}`),
    ])
      .then(([stats, timeline, commits]) => {
        setData({ stats, timeline, commits });
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [filters.days, filters.project, filters.granularity]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useToolDetail(tool: string | null, filters: DashboardFilters) {
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tool) { setDetail(null); return; }
    setLoading(true);
    const params = buildParams(filters, { tool });
    fetchJson<ToolDetail>(`/api/tool-detail${params}`)
      .then((d) => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [tool, filters.days, filters.project, filters.granularity]);

  return { detail, loading };
}
