"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  Stats, ActivityRow, HeatmapRow, TokenRow, ToolRow, ProjectRow, ModelRow,
  SessionRow, SkillRow, ToolDetail, StumbleRow, DarkSpendRow,
  SecurityFindingRow, SecurityTimelineRow, SecuritySessionRow,
  PermissionRow, ExistingSettings,
  GitStats, GitTimelineRow, GitCommitRow, GitSessionRow,
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
  agent?: string | null;
  granularity?: string;
  model?: string | null;
  tool?: string | null;
}

function buildParams(f: DashboardFilters, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (f.days) p.set("days", String(f.days));
  if (f.project) p.set("project", f.project);
  if (f.agent) p.set("agent", f.agent);
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
  const { days, project, agent, granularity, model, tool } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity, model, tool });

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
  }, [days, project, agent, granularity, model, tool, tick]);

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

export function useAgentList() {
  const [agents, setAgents] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-list")
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setAgents(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return agents;
}

export function useToolList() {
  const [tools, setTools] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tool-list")
      .then((r) => r.json())
      .then((data) => { if (!cancelled && Array.isArray(data)) setTools(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return tools;
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

export function useSessionCommits(sessionId: string | null) {
  const [commits, setCommits] = useState<GitCommitRow[] | null>(null);

  useEffect(() => {
    if (!sessionId) return;          // can't pre-clear via setState here:
                                     // react-hooks/set-state-in-effect bans
                                     // synchronous state updates from
                                     // effects (cascading-renders risk).
    let cancelled = false;
    fetchJson<GitCommitRow[]>(`/api/session-commits?id=${encodeURIComponent(sessionId)}`)
      .then((d) => { if (!cancelled) setCommits(d); })
      .catch(() => { if (!cancelled) setCommits([]); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Derive null when no sessionId (instead of clearing inside the effect).
  // commits may still hold a previous session's data during the transition,
  // so gate on sessionId here.
  return sessionId ? commits : null;
}

export function useHeatmap(filters: DashboardFilters) {
  const [rows, setRows] = useState<HeatmapRow[] | null>(null);
  const { days, project, agent, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity });
    fetchJson<HeatmapRow[]>(`/api/heatmap${params}`)
      .then((d) => { if (!cancelled) setRows(d); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [days, project, agent, granularity]);

  return rows;
}

export function useGitSessions(filters: DashboardFilters, enabled: boolean) {
  const [sessions, setSessions] = useState<GitSessionRow[] | null>(null);
  const { days, project, agent, granularity } = filters;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity });
    fetchJson<GitSessionRow[]>(`/api/git-sessions${params}`)
      .then((d) => { if (!cancelled) setSessions(d); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [enabled, days, project, agent, granularity]);

  return sessions;
}

export function useStumbles(filters: DashboardFilters, limit = 50) {
  const [incidents, setIncidents] = useState<StumbleRow[] | null>(null);
  const { days, project, agent, tool, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, tool, granularity }, { limit: String(limit) });
    fetchJson<StumbleRow[]>(`/api/stumbles${params}`)
      .then((d) => { if (!cancelled) setIncidents(d); })
      .catch(() => { if (!cancelled) setIncidents([]); });
    return () => { cancelled = true; };
  }, [days, project, agent, tool, granularity, limit]);

  return incidents;
}

function useSessionRollupEndpoint(endpoint: string, filters: DashboardFilters, limit: number) {
  const [rows, setRows] = useState<DarkSpendRow[] | null>(null);
  const { days, project, agent, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity }, { limit: String(limit) });
    fetchJson<DarkSpendRow[]>(`${endpoint}${params}`)
      .then((d) => { if (!cancelled) setRows(d); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [endpoint, days, project, agent, granularity, limit]);

  return rows;
}

export function useDarkSpend(filters: DashboardFilters, limit = 50) {
  return useSessionRollupEndpoint("/api/dark-spend", filters, limit);
}

export function useZeroCode(filters: DashboardFilters, limit = 50) {
  return useSessionRollupEndpoint("/api/zero-code", filters, limit);
}

export function usePermissions(filters: DashboardFilters) {
  const [rows, setRows] = useState<PermissionRow[] | null>(null);
  const { days, project, agent, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity });
    fetchJson<PermissionRow[]>(`/api/permissions${params}`)
      .then((d) => { if (!cancelled) setRows(d); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [days, project, agent, granularity]);

  return rows;
}

/**
 * Fetch the user's existing Claude Code permission settings for the
 * currently-selected project (user-global ∪ project-shared ∪
 * project-local). Returns null while loading; an `ExistingSettings`
 * shape once resolved (with empty arrays when nothing was found, never
 * null on the inner fields). Re-fetches when the project changes.
 */
export function useExistingPermissions(project: string | null) {
  const [data, setData] = useState<ExistingSettings | null>(null);
  // Reset stale data the moment the project changes (don't wait for
  // the new fetch to land). React 19's set-state-in-effect rule
  // disallows synchronous setState inside useEffect; this prev-prop
  // pattern is the documented escape hatch.
  const [prevProject, setPrevProject] = useState(project);
  if (prevProject !== project) {
    setPrevProject(project);
    setData(null);
  }

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const url = `/api/permissions/existing?project=${encodeURIComponent(project)}`;
    fetchJson<ExistingSettings>(url)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData({ allow: [], sources: [], repoLocal: null }); });
    return () => { cancelled = true; };
  }, [project]);

  return data;
}

export function useSecurity(filters: DashboardFilters) {
  const [findings, setFindings] = useState<SecurityFindingRow[] | null>(null);
  const [timeline, setTimeline] = useState<SecurityTimelineRow[] | null>(null);
  const [sessions, setSessions] = useState<SecuritySessionRow[] | null>(null);
  const { days, project, agent, granularity } = filters;

  useEffect(() => {
    let cancelled = false;
    const params = buildParams({ days, project, agent, granularity });
    Promise.all([
      fetchJson<SecurityFindingRow[]>(`/api/security/findings${params}`),
      fetchJson<SecurityTimelineRow[]>(`/api/security/timeline${params}`),
      fetchJson<SecuritySessionRow[]>(`/api/security/sessions${params}`),
    ])
      .then(([f, t, s]) => {
        if (cancelled) return;
        setFindings(f); setTimeline(t); setSessions(s);
      })
      .catch(() => {
        if (cancelled) return;
        setFindings([]); setTimeline([]); setSessions([]);
      });
    return () => { cancelled = true; };
  }, [days, project, agent, granularity]);

  return { findings, timeline, sessions };
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
