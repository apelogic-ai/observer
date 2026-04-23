"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AGENT_COLORS, agentColor } from "@/lib/colors";
import { formatNumber } from "@/lib/format";
import type { ToolRow, SkillRow } from "@/lib/queries";
import type { DashboardFilters } from "@/hooks/use-dashboard";

interface Props {
  data: ToolRow[];
  skills: SkillRow[];
  filters: DashboardFilters;
  onToolClick?: (tool: string) => void;
}

function AgentLegend() {
  return (
    <div className="flex gap-3 text-xs text-muted-foreground">
      {Object.entries(AGENT_COLORS).map(([agent, color]) => (
        <div key={agent} className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          <span>{agent.replace("_", " ")}</span>
        </div>
      ))}
    </div>
  );
}

function ToolTooltip({ active, payload }: { active?: boolean; payload?: { payload: ToolRow }[] }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;
  return (
    <div className="bg-[#171717] border border-white/10 rounded-lg p-2.5 text-xs shadow-lg">
      <div className="font-medium text-[#e6edf3] mb-1">{entry.tool_name}</div>
      <div className="text-[#8b949e]">{formatNumber(entry.count)} calls</div>
      {entry.agents?.length > 0 && (
        <div className="flex gap-2 mt-1.5">
          {entry.agents.map((a) => (
            <span key={a} className="flex items-center gap-1">
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ backgroundColor: agentColor(a) }}
              />
              <span style={{ color: agentColor(a) }}>{a.replace("_", " ")}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolChart({ data, skills, onToolClick }: Props) {
  const top = data.slice(0, 15);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <CardTitle>Top Tools</CardTitle>
            <AgentLegend />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResponsiveContainer width="100%" height={Math.max(240, top.length * 28)}>
          <BarChart data={top} layout="vertical" margin={{ left: 80 }}>
            <XAxis
              type="number"
              tick={{ fill: "#8b949e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              type="category"
              dataKey="tool_name"
              tick={{ fill: "#e6edf3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={80}
            />
            <Tooltip content={<ToolTooltip />} cursor={{ fill: "rgba(255,255,255,0.03)" }} />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              cursor={onToolClick ? "pointer" : undefined}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={onToolClick ? (entry: any) => onToolClick(entry.tool_name) : undefined}
            >
              {top.map((entry) => (
                <Cell
                  key={entry.tool_name}
                  fill={agentColor(entry.primary_agent)}
                  fillOpacity={0.75}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* Skills */}
        {skills.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground mb-2">Skills Used</p>
            <div className="flex flex-wrap gap-2">
              {skills.map((s) => (
                <Badge key={s.skill} variant="secondary" className="text-xs font-mono">
                  {s.skill}
                  <span className="ml-1.5 text-muted-foreground">{s.count}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
