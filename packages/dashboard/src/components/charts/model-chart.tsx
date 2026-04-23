"use client";

import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_PALETTE } from "@/lib/colors";
import { formatNumber } from "@/lib/format";
import type { ModelRow } from "@/lib/queries";

interface Props {
  data: ModelRow[];
  onModelClick?: (model: string) => void;
}

function shortModelName(model: string): string {
  const m = model.replace("claude-", "").replace(/-\d{8}$/, "");
  return m;
}

export function ModelChart({ data, onModelClick }: Props) {
  const chartData = data.map((r) => ({
    name: shortModelName(r.model),
    fullName: r.model,
    value: r.count,
    tokens: r.total_tokens,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
              nameKey="name"
              cursor={onModelClick ? "pointer" : undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={onModelClick ? (entry: any) => onModelClick(entry.fullName) : undefined}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: "#171717",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value) => formatNumber(Number(value))}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value: string) => <span style={{ color: "#e6edf3" }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
