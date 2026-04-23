"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_PALETTE } from "@/lib/colors";
import { formatNumber } from "@/lib/format";
import type { ProjectRow } from "@/lib/queries";

interface Props {
  data: ProjectRow[];
  onProjectClick?: (project: string) => void;
}

export function ProjectChart({ data, onProjectClick }: Props) {
  const top = data.slice(0, 12);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(240, top.length * 32)}>
          <BarChart data={top} layout="vertical" margin={{ left: 100 }}>
            <XAxis
              type="number"
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatNumber}
            />
            <YAxis
              type="category"
              dataKey="project"
              tick={{ fill: "#e6edf3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={100}
            />
            <Tooltip
              contentStyle={{
                background: "#171717",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value) => formatNumber(Number(value))}
            />
            <Bar
              dataKey="entries"
              radius={[0, 4, 4, 0]}
              cursor={onProjectClick ? "pointer" : undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={onProjectClick ? (entry: any) => onProjectClick(entry.project) : undefined}
            >
              {top.map((entry, i) => (
                <Cell key={entry.project} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
