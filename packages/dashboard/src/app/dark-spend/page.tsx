"use client";

import Link from "next/link";
import { useDarkSpend, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

function activeMin(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export default function DarkSpendPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const rows = useDarkSpend(dashFilters, 100);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Dark spend"
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
          <CardTitle>Sessions ranked by tokens / max(LoC, 1)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Two failure modes share one ranking. Sessions with zero commits
            score tokens / 1 — pure flail. Sessions with commits but tiny
            diffs score tokens / LoC — wasteful. The first row is the
            agent&apos;s most expensive session per line of code shipped.
            Note: this metric assumes the agent is shipping code. For
            projects where you use agents for data access or analysis
            instead of coding, &quot;zero commits&quot; is expected — filter
            those projects out before drawing conclusions.
          </p>
        </CardHeader>
        <CardContent>
          {rows === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {rows !== null && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No sessions in this window.
            </p>
          )}
          {rows !== null && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr className="border-b border-border">
                  <th className="py-2 font-medium">Session</th>
                  <th className="py-2 font-medium">Agent</th>
                  <th className="py-2 font-medium tabular-nums text-right" title="Active wall time — first/last event minus idle gaps over 5 minutes. Sessions reused across days no longer show as multi-day.">
                    Active min
                  </th>
                  <th className="py-2 font-medium tabular-nums text-right">Tokens</th>
                  <th className="py-2 font-medium tabular-nums text-right">Commits</th>
                  <th className="py-2 font-medium tabular-nums text-right">LoC Δ</th>
                  <th className="py-2 font-medium tabular-nums text-right">Tokens / LoC</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sessionId} className="border-b border-border/50">
                    <td className="py-2">
                      <Link
                        href={`/session?id=${encodeURIComponent(r.sessionId)}`}
                        className="text-primary hover:underline font-mono text-xs"
                      >
                        {r.sessionId.slice(0, 12)}
                      </Link>
                      {r.project && (
                        <span className="ml-2 text-xs text-muted-foreground">{r.project}</span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{r.agent.replace("_", " ")}</td>
                    <td className="py-2 tabular-nums text-right">{activeMin(r.activeMs)}</td>
                    <td className="py-2 tabular-nums text-right">{formatNumber(r.tokens)}</td>
                    <td className={`py-2 tabular-nums text-right ${r.commits === 0 ? "text-destructive" : ""}`}>
                      {r.commits}
                    </td>
                    <td className="py-2 tabular-nums text-right">{formatNumber(r.locDelta)}</td>
                    <td className="py-2 tabular-nums text-right">{formatNumber(Math.round(r.tokensPerLoc))}</td>
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
