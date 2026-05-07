"use client";

import Link from "next/link";
import { useState } from "react";
import { useSkillUsage, useSkillSessions, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import type { SkillUsageRow } from "@/lib/queries";

/**
 * Per-skill usage page. Two signals are unioned server-side into one
 * row per canonical name:
 *
 *   - user-typed slash prompts (`/<name> ...`) — rare in practice, since
 *     Claude Code expands these client-side before recording the message
 *   - `Skill` tool invocations the model fired (the dominant signal)
 *
 * Rows are tagged with the agent(s) that fired them. Today only Claude
 * Code has a Skill primitive, so the column is effectively claude_code-
 * only — Codex sessions surface no skills, which is correct.
 *
 * Sorted by total count desc; ties break alphabetically. No drill-down
 * for v1 — once we see what shows up we can add per-skill timeseries
 * and session lists.
 */

function formatRelative(iso: string): string {
  // Shows "today", "Nd ago", or YYYY-MM-DD for older entries. The page
  // header window is the dominant filter; this is just for orientation.
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 10);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

export default function SkillsPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const data = useSkillUsage(filters);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Skills"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
        onProjectChange={setProject}
        showProjectSelector
        onAgentChange={setAgent}
        showAgentSelector
        onRefresh={() => window.location.reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>Skill usage</CardTitle>
          <p className="text-sm text-muted-foreground">
            How often each skill ran in the selected window. The dominant
            signal is the model firing the{" "}
            <code className="text-xs">Skill</code> tool (captured as{" "}
            <code className="text-xs">skill:&lt;name&gt;</code>); a small
            additional signal comes from user-typed slash prompts.
            Codex doesn&apos;t expose a skill primitive today, so its
            rows are empty by design.
          </p>
        </CardHeader>
        <CardContent>
          {data === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : data.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No skills observed in this window. Try widening the date
              range or clearing project / agent filters.
            </div>
          ) : (
            <SkillsTable rows={data} filters={filters} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function SkillsTable({ rows, filters }: { rows: SkillUsageRow[]; filters: DashboardFilters }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal w-6"></th>
          <th className="text-left py-2 font-normal">Skill</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-right py-2 font-normal">Count</th>
          <th className="text-right py-2 font-normal">Sessions</th>
          <th className="text-right py-2 font-normal">Projects</th>
          <th className="text-right py-2 font-normal">First seen</th>
          <th className="text-right py-2 font-normal">Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const isOpen = expanded === r.name;
          return (
            <SkillRowGroup
              key={r.name}
              row={r}
              filters={filters}
              isOpen={isOpen}
              onToggle={() => setExpanded(isOpen ? null : r.name)}
            />
          );
        })}
      </tbody>
    </table>
  );
}

interface SkillRowGroupProps {
  row: SkillUsageRow;
  filters: DashboardFilters;
  isOpen: boolean;
  onToggle: () => void;
}

function SkillRowGroup({ row, filters, isOpen, onToggle }: SkillRowGroupProps) {
  return (
    <>
      <tr
        className="border-b border-border/40 cursor-pointer hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="py-2 text-center text-muted-foreground select-none">{isOpen ? "▼" : "▶"}</td>
        <td className="py-2 font-mono">/{row.name}</td>
        <td className="py-2">
          <div className="flex gap-1">
            {row.agents.map((a) => (
              <Badge
                key={a}
                variant="outline"
                className="text-[10px]"
                style={{ borderColor: AGENT_COLORS[a], color: AGENT_COLORS[a] }}
              >
                {a.replace("_", " ")}
              </Badge>
            ))}
          </div>
        </td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.count)}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.sessions)}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.projects)}</td>
        <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRelative(row.firstSeen)}</td>
        <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRelative(row.lastSeen)}</td>
      </tr>
      {isOpen && (
        <tr>
          <td></td>
          <td colSpan={7} className="pb-3">
            <SessionList name={row.name} filters={filters} />
          </td>
        </tr>
      )}
    </>
  );
}

function SessionList({ name, filters }: { name: string; filters: DashboardFilters }) {
  const sessions = useSkillSessions(name, filters);
  if (sessions === null) return <div className="text-xs text-muted-foreground py-2">Loading…</div>;
  if (sessions.length === 0) return <div className="text-xs text-muted-foreground py-2">No sessions in this window.</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="text-left py-1 font-normal">Session</th>
          <th className="text-left py-1 font-normal">Project</th>
          <th className="text-right py-1 font-normal">Calls</th>
          <th className="text-right py-1 font-normal">First</th>
          <th className="text-right py-1 font-normal">Last</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={`${s.sessionId}\t${s.agent}`} className="border-t border-border/30">
            <td className="py-1 font-mono">
              <Link href={`/session?id=${encodeURIComponent(s.sessionId)}`} className="text-brand hover:underline">
                {s.sessionId.slice(0, 12)}
              </Link>
            </td>
            <td className="py-1">{s.project}</td>
            <td className="py-1 tabular-nums text-right">{formatNumber(s.count)}</td>
            <td className="py-1 tabular-nums text-right text-muted-foreground">{formatRelative(s.firstSeen)}</td>
            <td className="py-1 tabular-nums text-right text-muted-foreground">{formatRelative(s.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
