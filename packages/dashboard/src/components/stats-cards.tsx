"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { Stats } from "@/lib/queries";

export function StatsCards({ stats }: { stats: Stats }) {
  const cards = [
    { label: "Sessions", value: formatNumber(stats.total_sessions) },
    { label: "Entries", value: formatNumber(stats.total_entries) },
    { label: "Active Days", value: String(stats.total_days) },
    { label: "Projects", value: String(stats.total_projects) },
    { label: "Input Tokens", value: formatNumber(stats.total_input_tokens) },
    { label: "Output Tokens", value: formatNumber(stats.total_output_tokens) },
    { label: "Cache Reads", value: formatNumber(stats.total_cache_read) },
    { label: "Cache Writes", value: formatNumber(stats.total_cache_creation) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {c.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold tabular-nums">{c.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
