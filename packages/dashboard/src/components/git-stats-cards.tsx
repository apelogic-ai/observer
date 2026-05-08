"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { GitStats } from "@/lib/queries";

export function GitStatsCards({ stats }: { stats: GitStats }) {
  const agentPct = stats.total_commits > 0
    ? Math.round((stats.agent_commits / stats.total_commits) * 100)
    : 0;
  // Attribution coverage: of the agent commits, how many actually link
  // back to a captured session. Anything not 100% means the session
  // backfill missed the commit (project mismatch, timestamp gap, …).
  // Surfacing this matters because every session-level metric uses
  // linked agent commits as its denominator.
  const linkedPct = stats.agent_commits > 0
    ? Math.round((stats.linked_agent_commits / stats.agent_commits) * 100)
    : 0;

  const cards = [
    { label: "Total Commits", value: formatNumber(stats.total_commits) },
    { label: "Agent Commits", value: `${formatNumber(stats.agent_commits)} (${agentPct}%)` },
    { label: "Agent Linked",   value: `${formatNumber(stats.linked_agent_commits)} (${linkedPct}%)` },
    { label: "Agent Unlinked", value: formatNumber(stats.unlinked_agent_commits) },
    { label: "Human Commits", value: formatNumber(stats.human_commits) },
    { label: "Lines Added", value: formatNumber(stats.total_insertions) },
    { label: "Lines Deleted", value: formatNumber(stats.total_deletions) },
    { label: "Agent Lines", value: formatNumber(stats.agent_insertions) },
    { label: "Files Changed", value: formatNumber(stats.files_changed) },
    { label: "Repos", value: String(stats.repos) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
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
