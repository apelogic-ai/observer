"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_COLORS, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE } from "@/lib/colors";
import { formatDate, formatNumber } from "@/lib/format";
import { pickAxisLabelInterval } from "@/lib/chart-axis";
import type { ActivityRow } from "@/lib/queries";

interface Props {
  data: ActivityRow[];
}

export function ActivityChart({ data }: Props) {
  // Pivot: { date, claude_code, codex, cursor }
  const agents = [...new Set(data.map((r) => r.agent))];
  const byDate = new Map<string, Record<string, string | number>>();

  for (const row of data) {
    const entry = byDate.get(row.date) ?? { date: row.date };
    // Stack by tokens, not entry count — agents differ ~100x in entries
    // but consume comparable tokens. Skip zero-token rows; sub-1%
    // contributors won't be visible as a bar but still show up in the
    // legend and per-day tooltip, which is enough.
    if (row.total_tokens > 0) entry[row.agent] = row.total_tokens;
    byDate.set(row.date, entry);
  }

  const chartData = [...byDate.values()];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Activity Timeline
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            tokens (input + output + cache reads + writes)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData}>
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              // Thin labels for long ranges so they don't crowd. Bars
              // stay daily; only the labels get sparsified.
              interval={pickAxisLabelInterval(chartData.length)}
            />
            <YAxis
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={50}
              tickFormatter={formatNumber}
            />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              labelFormatter={(v) => formatDate(String(v))}
              formatter={(value) => formatNumber(Number(value))}
            />
            {/* Legend only adds info when there's more than one series.
                With a single agent (e.g. agent filter active) the legend
                just repeats the agent name, so hide it. */}
            {agents.length > 1 && (
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(value) => String(value ?? "").replace("_", " ")}
              />
            )}
            {agents.map((agent) => (
              <Bar
                key={agent}
                dataKey={agent}
                stackId="a"
                fill={AGENT_COLORS[agent] ?? "#8b949e"}
                radius={[2, 2, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
