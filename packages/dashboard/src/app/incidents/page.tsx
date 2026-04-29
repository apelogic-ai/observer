"use client";

import Link from "next/link";
import { useIncidents, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

function durationMin(firstAt: string, lastAt: string): number {
  const ms = Date.parse(lastAt) - Date.parse(firstAt);
  return Math.max(0, Math.round(ms / 60_000));
}

export default function IncidentsPage() {
  const { filters, setDays, setAgent, setTool, setProject, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const incidents = useIncidents(dashFilters, 100);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Redundant loops"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
        onProjectChange={setProject}
        showProjectSelector
        onAgentChange={setAgent}
        showAgentSelector
        onToolChange={setTool}
        showToolSelector
        onRefresh={() => window.location.reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>Per-session repeated invocations</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each row is one session where the agent ran the same normalized
            tool invocation 3+ times. Generic across tools — db-mcp shell
            spam, repeated reads of the same file, status hammering all
            surface here. Paths and quoted strings are collapsed so
            near-identical commands cluster.
          </p>
        </CardHeader>
        <CardContent>
          {incidents === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {incidents !== null && incidents.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No redundant loops detected in this window. Either no session
              repeated the same invocation 3+ times, or trace disclosure is
              too low for shape detection (need command + filePath).
            </p>
          )}
          {incidents !== null && incidents.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr className="border-b border-border">
                  <th className="py-2 font-medium">Session</th>
                  <th className="py-2 font-medium">Agent</th>
                  <th className="py-2 font-medium">Tool</th>
                  <th className="py-2 font-medium">Invocation</th>
                  <th className="py-2 font-medium tabular-nums text-right">×</th>
                  <th className="py-2 font-medium tabular-nums text-right" title="Total tokens for the session that contained this loop — codex tool calls don't carry per-call tokens, so session-level is the cost frame.">
                    Session tokens
                  </th>
                  <th className="py-2 font-medium tabular-nums text-right">Min</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={`${i.sessionId}-${i.toolName}-${i.shape}`} className="border-b border-border/50">
                    <td className="py-2">
                      <Link
                        href={`/session?id=${encodeURIComponent(i.sessionId)}`}
                        className="text-primary hover:underline font-mono text-xs"
                      >
                        {i.sessionId.slice(0, 12)}
                      </Link>
                      {i.project && (
                        <span className="ml-2 text-xs text-muted-foreground">{i.project}</span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{i.agent.replace("_", " ")}</td>
                    <td className="py-2">{i.toolName}</td>
                    <td className="py-2">
                      <code className="text-xs text-muted-foreground break-all">{i.shape}</code>
                    </td>
                    <td className="py-2 tabular-nums text-right">{formatNumber(i.occurrences)}</td>
                    <td className="py-2 tabular-nums text-right">{formatNumber(i.sessionTokens)}</td>
                    <td className="py-2 tabular-nums text-right">{durationMin(i.firstAt, i.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
