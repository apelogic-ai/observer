"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useToolDetail, type DashboardFilters } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EntityList } from "@/components/entity-list";
import { AGENT_COLORS, agentColor } from "@/lib/colors";
import { formatDate, formatNumber } from "@/lib/format";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

export default function ToolPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const toolName = decodeURIComponent(name);
  const router = useRouter();
  const { filters, setDays, setGranularity, buildQs } = useFilters();
  const dashFilters: DashboardFilters = { ...filters };
  const { detail, loading } = useToolDetail(toolName, dashFilters);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title={toolName}
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
        onRefresh={() => window.location.reload()}
      />

      {loading && !detail && (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading...
        </div>
      )}

      {detail && (
        <>
          {/* Summary */}
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="text-sm">{formatNumber(detail.total)} total calls</Badge>
            {detail.byAgent.map((a) => (
              <Badge
                key={a.agent}
                variant="outline"
                className="text-sm"
                style={{ borderColor: AGENT_COLORS[a.agent], color: AGENT_COLORS[a.agent] }}
              >
                {a.agent.replace("_", " ")}: {formatNumber(a.count)}
              </Badge>
            ))}
          </div>

          {/* Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Usage Over Time</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={detail.timeline}>
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
                    contentStyle={{
                      background: "#171717",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(v) => formatDate(String(v))}
                    formatter={(value) => [formatNumber(Number(value)), "calls"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    stroke="#58a6ff"
                    fill="#58a6ff"
                    fillOpacity={0.2}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Commands */}
            {detail.commands.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Top Commands</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5 max-h-80 overflow-y-auto">
                    {detail.commands.map((c) => (
                      <div key={c.value} className="flex items-start justify-between gap-2 text-sm">
                        <code className="text-muted-foreground break-all text-xs">{c.value}</code>
                        <span className="tabular-nums text-foreground shrink-0">{c.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Files */}
            {detail.files.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Top Files</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1.5 max-h-80 overflow-y-auto">
                    {detail.files.map((f) => (
                      <div key={f.value} className="flex items-start justify-between gap-2 text-sm">
                        <code className="text-muted-foreground break-all text-xs">{f.value}</code>
                        <span className="tabular-nums text-foreground shrink-0">{f.count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <EntityList
              title="Projects"
              items={detail.projects.map((p) => ({
                name: p.project,
                count: p.count,
                href: `/project/${encodeURIComponent(p.project)}${buildQs({ project: null })}`,
              }))}
            />
            <EntityList
              title="Models"
              items={detail.models.map((m) => ({
                name: m.model,
                count: m.count,
                href: `/model/${encodeURIComponent(m.model)}${buildQs()}`,
              }))}
            />
          </div>
        </>
      )}
    </main>
  );
}
