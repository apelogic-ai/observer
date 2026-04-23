"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_COLORS } from "@/lib/colors";
import { formatDate } from "@/lib/format";
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
    entry[row.agent] = row.count;
    byDate.set(row.date, entry);
  }

  const chartData = [...byDate.values()];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity Timeline</CardTitle>
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
            />
            <YAxis
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={{
                background: "#171717",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => formatDate(String(v))}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value) => String(value ?? "").replace("_", " ")}
            />
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
