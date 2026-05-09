"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useInterventionRate } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import type { InterventionRateRow } from "@/lib/queries";

/**
 * "How much steering did the agent need?" surfaced per session.
 * Counts user-message turns (the human-typed prompts) against the
 * agent's own work (tool calls, commits, LoC). The headline ratio
 * is `tools per user turn`: high = autonomous, low = stalling.
 *
 * Only sessions with ≥1 user turn appear — system-only sessions
 * carry no intervention signal. Sorted userTurns descending so the
 * most-handheld sessions land at the top.
 */

function formatRatio(n: number | null, unit: string): string {
  if (n === null) return "—";
  if (n >= 100) return `${Math.round(n)} ${unit}`;
  if (n >= 10) return `${n.toFixed(1)} ${unit}`;
  return `${n.toFixed(2)} ${unit}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function AutonomyPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const data = useInterventionRate(filters);

  const summary = useMemo(() => {
    if (!data || data.length === 0) return null;
    const total = data.length;
    const totalTurns = data.reduce((acc, r) => acc + r.userTurns, 0);
    const avgTurns = totalTurns / total;
    // Median tools-per-turn — but only over sessions where the
    // agent actually used tools. ~80% of sessions on the live data
    // are pure chat (user talked to the model, no tool calls), so
    // including them collapses the median to 0 and hides the
    // signal we want: "when the agent did something, how much did
    // it do per nudge".
    const active = data.filter((r) => r.toolCalls > 0);
    const ratios = [...active.map((r) => r.toolsPerTurn)].sort((a, b) => a - b);
    const medianTpt = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)]! : 0;
    const chatOnly = total - active.length;
    return { total, totalTurns, avgTurns, medianTpt, activeCount: active.length, chatOnly };
  }, [data]);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Autonomy"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
        onProjectChange={setProject}
        showProjectSelector
        onAgentChange={setAgent}
        showAgentSelector
        onRefresh={() => window.location.reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>How much steering did the agent need?</CardTitle>
          <p className="text-sm text-muted-foreground">
            Counts user-message turns (each prompt the human typed)
            against what the agent did between them. <strong>Tools
            per turn</strong> is the headline ratio: high values mean
            the agent ran a lot of work per nudge (autonomous), low
            values mean it stalled and waited (handheld). Sessions
            with extreme intervention counts (the doc&apos;s motivating
            example: 375 / 240 / 149 turns) land at the top.
          </p>
        </CardHeader>
        {summary && (
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard
                label="Sessions w/ tools"
                value={`${summary.activeCount} / ${summary.total}`}
                hint={`${summary.chatOnly} chat-only`}
              />
              <SummaryCard label="Total user turns" value={formatNumber(summary.totalTurns)} />
              <SummaryCard label="Avg turns / session" value={summary.avgTurns.toFixed(1)} />
              <SummaryCard
                label="Median tools / turn"
                value={summary.medianTpt.toFixed(1)}
                hint="active sessions only"
              />
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions, ranked by user-turn count</CardTitle>
        </CardHeader>
        <CardContent>
          {data === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : data.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No sessions with user turns in this window.
            </div>
          ) : (
            <InterventionTable rows={data} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function InterventionTable({ rows }: { rows: InterventionRateRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-right py-2 font-normal">User turns</th>
          <th className="text-right py-2 font-normal">Tool calls</th>
          <th className="text-right py-2 font-normal">Tools/turn</th>
          <th className="text-right py-2 font-normal">Commits</th>
          <th className="text-right py-2 font-normal">Turns/commit</th>
          <th className="text-right py-2 font-normal">LoC</th>
          <th className="text-right py-2 font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sessionId} className="border-b border-border/40">
            <td className="py-2 font-mono">
              <Link href={`/session?id=${encodeURIComponent(r.sessionId)}`} className="text-brand hover:underline">
                {r.sessionId.slice(0, 12)}
              </Link>
            </td>
            <td className="py-2">
              <Badge
                variant="outline"
                className="text-[10px]"
                style={{ borderColor: AGENT_COLORS[r.agent], color: AGENT_COLORS[r.agent] }}
              >
                {r.agent.replace("_", " ")}
              </Badge>
            </td>
            <td className="py-2 text-muted-foreground">{r.project ?? "—"}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.userTurns)}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.toolCalls)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRatio(r.toolsPerTurn, "")}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.commits)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRatio(r.turnsPerCommit, "")}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.locDelta)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatTokens(r.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
