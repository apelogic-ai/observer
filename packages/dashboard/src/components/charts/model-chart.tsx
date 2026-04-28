"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_PALETTE, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE } from "@/lib/colors";
import { formatNumber } from "@/lib/format";
import type { ModelRow } from "@/lib/queries";

interface Props {
  data: ModelRow[];
  onModelClick?: (model: string) => void;
}

function shortModelName(model: string): string {
  return model.replace("claude-", "").replace(/-\d{8}$/, "");
}

export function ModelChart({ data, onModelClick }: Props) {
  const chartData = data
    .filter((r) => r.total_tokens > 0)
    .map((r) => ({
      name: shortModelName(r.model),
      fullName: r.model,
      tokens: r.total_tokens,
      count: r.count,
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Models
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            tokens (input + output + cache reads + writes)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(240, chartData.length * 32)}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 100, right: 60 }}>
            <XAxis
              type="number"
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={formatNumber}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fill: "#e6edf3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={100}
            />
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              formatter={(value) => [formatNumber(Number(value)), "tokens"]}
            />
            <Bar
              dataKey="tokens"
              radius={[0, 4, 4, 0]}
              cursor={onModelClick ? "pointer" : undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={onModelClick ? (entry: any) => onModelClick(entry.fullName) : undefined}
            >
              {chartData.map((entry, i) => (
                <Cell key={entry.fullName} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              ))}
              <LabelList
                dataKey="tokens"
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
