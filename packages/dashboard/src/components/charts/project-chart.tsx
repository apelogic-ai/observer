"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_PALETTE, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE } from "@/lib/colors";
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
        <CardTitle>
          Projects
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            tokens (input + output + cache reads + writes)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(240, top.length * 32)}>
          <BarChart data={top} layout="vertical" margin={{ left: 100, right: 60 }}>
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
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              formatter={(value) => formatNumber(Number(value))}
            />
            <Bar
              dataKey="total_tokens"
              radius={[0, 4, 4, 0]}
              cursor={onProjectClick ? "pointer" : undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={onProjectClick ? (entry: any) => onProjectClick(entry.project) : undefined}
            >
              {top.map((entry, i) => (
                <Cell key={entry.project} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              ))}
              <LabelList
                dataKey="total_tokens"
                position="right"
                formatter={(v) => formatNumber(Number(v))}
                style={{ fill: "#e6edf3", fontSize: 11 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
