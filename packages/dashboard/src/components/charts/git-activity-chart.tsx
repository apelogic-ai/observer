"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GIT_COLORS } from "@/lib/colors";
import { formatDate, formatNumber } from "@/lib/format";
import type { GitTimelineRow } from "@/lib/queries";

interface Props {
  data: GitTimelineRow[];
}

export function GitActivityChart({ data }: Props) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Commits timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Commit Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data}>
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
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="agent_commits"
                name="Agent"
                stackId="commits"
                fill={GIT_COLORS.agent}
                radius={[2, 2, 0, 0]}
              />
              <Bar
                dataKey="human_commits"
                name="Human"
                stackId="commits"
                fill={GIT_COLORS.human}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Diff stats timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Lines Changed</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data}>
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
                width={50}
                tickFormatter={(v) => formatNumber(v)}
              />
              <Tooltip
                contentStyle={{
                  background: "#171717",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => formatDate(String(v))}
                formatter={(value) => formatNumber(Number(value))}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                dataKey="insertions"
                name="Insertions"
                stackId="diff"
                fill={GIT_COLORS.insertions}
                radius={[2, 2, 0, 0]}
              />
              <Bar
                dataKey="deletions"
                name="Deletions"
                stackId="diff"
                fill={GIT_COLORS.deletions}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
