"use client";

import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TOKEN_COLORS, TOOLTIP_CONTENT_STYLE, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE } from "@/lib/colors";
import { formatDate, formatNumber } from "@/lib/format";
import type { TokenRow } from "@/lib/queries";

interface Props {
  data: TokenRow[];
}

function MiniArea({ data, dataKey, name, color }: {
  data: TokenRow[];
  dataKey: string;
  name: string;
  color: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={80}>
      <AreaChart data={data}>
        <XAxis dataKey="date" hide />
        <YAxis
          tickFormatter={formatNumber}
          tick={{ fill: "#8b949e", fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={45}
        />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelFormatter={(v) => formatDate(String(v))}
          formatter={(value) => [formatNumber(Number(value)), name]}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          name={name}
          stroke={color}
          fill={color}
          fillOpacity={0.2}
          strokeWidth={1.5}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TokenChart({ data }: Props) {
  const totalInput = data.reduce((s, r) => s + r.input_tokens, 0);
  const totalOutput = data.reduce((s, r) => s + r.output_tokens, 0);
  const totalCacheRead = data.reduce((s, r) => s + r.cache_read, 0);
  const totalCacheCreation = data.reduce((s, r) => s + r.cache_creation, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Token Usage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Input</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: TOKEN_COLORS.input }}>
              {formatNumber(totalInput)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Output</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: TOKEN_COLORS.output }}>
              {formatNumber(totalOutput)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Cache Read</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: TOKEN_COLORS.cache_read }}>
              {formatNumber(totalCacheRead)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Cache Write</p>
            <p className="text-xl font-bold tabular-nums" style={{ color: TOKEN_COLORS.cache_creation }}>
              {formatNumber(totalCacheCreation)}
            </p>
          </div>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Input</p>
          <MiniArea data={data} dataKey="input_tokens" name="Input" color={TOKEN_COLORS.input} />
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Output</p>
          <MiniArea data={data} dataKey="output_tokens" name="Output" color={TOKEN_COLORS.output} />
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Cache Reads</p>
          <ResponsiveContainer width="100%" height={50}>
            <BarChart data={data}>
              <XAxis dataKey="date" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelFormatter={(v) => formatDate(String(v))}
                formatter={(value) => [formatNumber(Number(value)), "Cache Read"]}
              />
              <Bar
                dataKey="cache_read"
                fill={TOKEN_COLORS.cache_read}
                fillOpacity={0.5}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">Cache Writes</p>
          <ResponsiveContainer width="100%" height={50}>
            <BarChart data={data}>
              <XAxis dataKey="date" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelFormatter={(v) => formatDate(String(v))}
                formatter={(value) => [formatNumber(Number(value)), "Cache Write"]}
              />
              <Bar
                dataKey="cache_creation"
                fill={TOKEN_COLORS.cache_creation}
                fillOpacity={0.5}
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
