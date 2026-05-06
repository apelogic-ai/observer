"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useSecurity, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatNumber } from "@/lib/format";
import { pickAxisLabelInterval } from "@/lib/chart-axis";
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from "@/lib/colors";

// Discrete categorical palette for the stacked bars — one color per
// pattern type. Cycles after 8 patterns; in practice 4–6 is the norm.
const PATTERN_PALETTE = [
  "#EF8626", "#3B82F6", "#10B981", "#F59E0B",
  "#A855F7", "#EC4899", "#14B8A6", "#F43F5E",
];

export default function SecurityPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, setDate, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const { findings, timeline, sessions } = useSecurity(dashFilters);

  // Pivot the per-(date, pattern) timeline rows into one chart row per
  // date with a numeric column per pattern, for stacked rendering.
  const { chartData, patternKeys } = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    const patterns = new Set<string>();
    for (const r of timeline ?? []) {
      patterns.add(r.patternType);
      const entry = byDate.get(r.date) ?? { date: r.date };
      entry[r.patternType] = ((entry[r.patternType] as number | undefined) ?? 0) + r.count;
      byDate.set(r.date, entry);
    }
    return {
      chartData: [...byDate.values()],
      patternKeys: [...patterns].sort(),
    };
  }, [timeline]);

  const colorFor = (pattern: string): string => {
    const idx = patternKeys.indexOf(pattern);
    return PATTERN_PALETTE[idx % PATTERN_PALETTE.length]!;
  };

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Leaks"
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
          <CardTitle>What&apos;s here</CardTitle>
          <p className="text-sm text-muted-foreground">
            Each row is one secret the agent&apos;s scanner caught and
            redacted in trace data — AWS keys, GitHub tokens, JWTs, DB
            URLs, etc. The actual secret value never reaches this
            dashboard; what we count is the redaction marker
            (<code className="text-xs">[REDACTED:&lt;type&gt;]</code>),
            and we attribute it to the session it appeared in.
          </p>
        </CardHeader>
      </Card>

      {filters.date && (
        <Card>
          <CardContent className="flex items-center justify-between py-3">
            <p className="text-sm">
              Showing findings for <span className="font-medium">{formatDate(filters.date)}</span>.
              The chart below stays scoped to your full window for context.
            </p>
            <button
              type="button"
              onClick={() => setDate(null)}
              className="text-xs px-3 py-1 rounded border border-border hover:bg-muted transition-colors"
            >
              Clear day
            </button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Findings over time</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Click a bar to drill into one day&apos;s findings.
          </p>
        </CardHeader>
        <CardContent>
          {timeline === null && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {timeline !== null && timeline.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No findings in this window.
            </p>
          )}
          {timeline !== null && timeline.length > 0 && (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#8b949e", fontSize: 11 }}
                  tickFormatter={(v) => formatDate(String(v))}
                  axisLine={false}
                  tickLine={false}
                  interval={pickAxisLabelInterval(chartData.length)}
                />
                <YAxis
                  tick={{ fill: "#8b949e", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={formatNumber}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  labelFormatter={(v) => formatDate(String(v))}
                  formatter={(value, name) => [formatNumber(Number(value)), String(name)]}
                />
                {patternKeys.length > 1 && (
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                )}
                {patternKeys.map((pattern) => (
                  <Bar
                    key={pattern}
                    dataKey={pattern}
                    stackId="a"
                    fill={colorFor(pattern)}
                    onClick={(payload) => {
                      // Recharts types `payload` loosely; the bar's
                      // underlying chart-row data lives on `.payload`
                      // when available, otherwise on the object itself.
                      const d = (payload as { payload?: { date?: string } } | undefined)?.payload
                        ?? (payload as unknown as { date?: string } | undefined);
                      if (d?.date) setDate(d.date === filters.date ? null : d.date);
                    }}
                    cursor="pointer"
                  >
                    {/* Highlight the selected day's segments by drawing
                        them at full opacity; dim everything else. */}
                    {chartData.map((d) => (
                      <Cell
                        key={String(d.date)}
                        fillOpacity={!filters.date || d.date === filters.date ? 1 : 0.3}
                      />
                    ))}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By pattern</CardTitle>
          </CardHeader>
          <CardContent>
            {findings === null && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {findings !== null && findings.length === 0 && (
              <p className="text-sm text-muted-foreground">No findings.</p>
            )}
            {findings !== null && findings.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left">
                  <tr className="border-b border-border">
                    <th className="py-2 font-medium">Pattern</th>
                    <th className="py-2 font-medium tabular-nums text-right">Count</th>
                    <th className="py-2 font-medium tabular-nums text-right">Sessions</th>
                    <th className="py-2 font-medium tabular-nums text-right">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f) => (
                    <tr key={f.patternType} className="border-b border-border/50">
                      <td className="py-2"><code className="text-xs">{f.patternType}</code></td>
                      <td className="py-2 tabular-nums text-right">{formatNumber(f.count)}</td>
                      <td className="py-2 tabular-nums text-right">{formatNumber(f.sessions)}</td>
                      <td className="py-2 tabular-nums text-right">{formatNumber(f.projects)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By session</CardTitle>
          </CardHeader>
          <CardContent>
            {sessions === null && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {sessions !== null && sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">No findings.</p>
            )}
            {sessions !== null && sessions.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left">
                  <tr className="border-b border-border">
                    <th className="py-2 font-medium">Session</th>
                    <th className="py-2 font-medium">Patterns</th>
                    <th className="py-2 font-medium tabular-nums text-right">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.sessionId} className="border-b border-border/50">
                      <td className="py-2">
                        <Link
                          href={`/session?id=${encodeURIComponent(s.sessionId)}`}
                          className="text-primary hover:underline font-mono text-xs"
                        >
                          {s.sessionId.slice(0, 12)}
                        </Link>
                        {s.project && (
                          <span className="ml-2 text-xs text-muted-foreground">{s.project}</span>
                        )}
                      </td>
                      <td className="py-2">
                        <span className="text-xs text-muted-foreground">{s.patterns.join(", ")}</span>
                      </td>
                      <td className="py-2 tabular-nums text-right">{formatNumber(s.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
