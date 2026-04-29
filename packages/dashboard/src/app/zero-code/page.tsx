"use client";

import Link from "next/link";
import { useZeroCode, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

function activeMin(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

export default function ZeroCodePage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const rows = useZeroCode(dashFilters, 100);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Zero code"
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
          <CardTitle>Sessions that produced zero LoC, ranked by tokens</CardTitle>
          <p className="text-sm text-muted-foreground">
            Two flavors live here. <strong>Flail</strong> — agent ran for
            hours and shipped nothing — and <strong>non-code work</strong>
            — agents you used for data access, analysis, or research where
            commits aren&apos;t the goal. The project filter is your
            sorting mechanism. Sessions with code shipped live on{" "}
            <Link href="/dark-spend" className="underline hover:text-brand">Dark spend</Link>{" "}
            instead.
          </p>
        </CardHeader>
        <CardContent>
          {rows === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {rows !== null && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No zero-LoC sessions in this window. Either every session
              committed something or there are no sessions at all.
            </p>
          )}
          {rows !== null && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left">
                <tr className="border-b border-border">
                  <th className="py-2 font-medium">Session</th>
                  <th className="py-2 font-medium">Agent</th>
                  <th className="py-2 font-medium tabular-nums text-right" title="Active wall time — first/last event minus idle gaps over 5 minutes.">
                    Active min
                  </th>
                  <th className="py-2 font-medium tabular-nums text-right">Tokens</th>
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
