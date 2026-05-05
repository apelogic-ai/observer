"use client";

import Link from "next/link";
import { useSecurity, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatNumber } from "@/lib/format";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from "@/lib/colors";

export default function SecurityPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const { findings, timeline, sessions } = useSecurity(dashFilters);

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

      <Card>
        <CardHeader>
          <CardTitle>Findings over time</CardTitle>
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
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={timeline}>
                <XAxis
                  dataKey="date"
                  tick={{ fill: "#8b949e", fontSize: 11 }}
                  tickFormatter={(v) => formatDate(String(v))}
                  axisLine={false}
                  tickLine={false}
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
                  formatter={(value) => [formatNumber(Number(value)), "findings"]}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#EF8626"
                  fill="#EF8626"
                  fillOpacity={0.2}
                  strokeWidth={1.5}
                />
              </AreaChart>
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
