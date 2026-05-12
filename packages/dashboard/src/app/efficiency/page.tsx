"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useSearchToEdit, useFirstActionLatency } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import { rollupByProject, type ProjectRollup } from "@/lib/project-rollup";
import type { SearchToEditRow, FirstActionLatencyRow } from "@/lib/queries";

/**
 * Two session-efficiency metrics side-by-side:
 *
 *   - Search-to-edit ratio: how much navigation happened per edit.
 *     High ratios suggest the repo lacks discoverable structure /
 *     docs / tests, or the agent thrashed before committing to a
 *     change.
 *
 *   - First useful action latency: time from the user's first
 *     message to the first edit / validation / commit. Long
 *     latencies = over-exploration before doing anything.
 *
 * Both filter to sessions with at least one edit; pure exploration
 * and chat-only sessions don't carry the signal we want.
 */

function formatRatio(n: number): string {
  if (n >= 100) return `${Math.round(n)}×`;
  if (n >= 10) return `${n.toFixed(1)}×`;
  return `${n.toFixed(2)}×`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "instant";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function EfficiencyPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const ratio = useSearchToEdit(filters);
  const latency = useFirstActionLatency(filters);

  const ratioByProject = useMemo(
    () => (ratio ? rollupByProject(ratio, { metric: (r) => r.ratio }) : null),
    [ratio],
  );
  const latencyByProject = useMemo(
    () => (latency ? rollupByProject(latency, { metric: (r) => r.latencyMs }) : null),
    [latency],
  );

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Efficiency"
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
          <CardTitle>Search-to-edit ratio (navigation friction)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Per session: read-shaped tool calls (Read / grep / find /
            ls / cat / git log) vs edit-shaped ones (Edit, Write,
            apply_patch). High <strong>ratio</strong> values mean the
            agent thrashed around before making a small change — the
            repo probably lacks discoverable structure, docs, or tests.
            Sorted ratio-desc; sessions with zero edits are excluded.
          </p>
        </CardHeader>
      </Card>

      {ratioByProject && ratioByProject.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By project</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Median read-to-edit ratio per session in each project,
              worst-first. A high median means every session in that
              project tends to thrash — not just one outlier.
            </p>
          </CardHeader>
          <CardContent>
            <RatioProjectTable rows={ratioByProject} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sessions, ranked by ratio</CardTitle>
        </CardHeader>
        <CardContent>
          {ratio === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : ratio.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No sessions edited code in this window.
            </div>
          ) : (
            <RatioTable rows={ratio} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>First useful action latency (over-exploration)</CardTitle>
          <p className="text-sm text-muted-foreground">
            Time between the most recent user message before the
            first useful action (edit, validation tool call, or
            linked agent commit) and that action. Long latencies
            mean the agent over-explored before doing anything.
            Capped at 2 hours — anything beyond is a session
            resumed after a long gap, not over-exploration.
            Sorted latency-desc.
          </p>
        </CardHeader>
      </Card>

      {latencyByProject && latencyByProject.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By project</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Median first-action latency per session in each project,
              worst-first.
            </p>
          </CardHeader>
          <CardContent>
            <LatencyProjectTable rows={latencyByProject} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sessions, ranked by latency</CardTitle>
        </CardHeader>
        <CardContent>
          {latency === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : latency.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No measurable session latencies in this window.
            </div>
          ) : (
            <LatencyTable rows={latency} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function RatioProjectTable({ rows }: { rows: ProjectRollup<SearchToEditRow>[] }) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-2 font-normal">Project</th>
            <th className="text-right py-2 font-normal">Sessions</th>
            <th className="text-right py-2 font-normal">Median ratio</th>
            <th className="text-right py-2 font-normal">Worst session</th>
            <th className="text-right py-2 font-normal">Worst ratio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.project} className="border-b border-border/40">
              <td className="py-2">{p.project}</td>
              <td className="py-2 tabular-nums text-right">{p.sessions}</td>
              <td className="py-2 tabular-nums text-right font-medium">{formatRatio(p.median)}</td>
              <td className="py-2 text-right">
                <Link
                  href={`/session?id=${encodeURIComponent(p.worst.sessionId)}`}
                  className="text-brand hover:underline font-mono text-xs"
                >
                  {p.worst.sessionId.slice(0, 12)}
                </Link>
              </td>
              <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRatio(p.worst.ratio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LatencyProjectTable({ rows }: { rows: ProjectRollup<FirstActionLatencyRow>[] }) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-2 font-normal">Project</th>
            <th className="text-right py-2 font-normal">Sessions</th>
            <th className="text-right py-2 font-normal">Median latency</th>
            <th className="text-right py-2 font-normal">Worst session</th>
            <th className="text-right py-2 font-normal">Worst latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.project} className="border-b border-border/40">
              <td className="py-2">{p.project}</td>
              <td className="py-2 tabular-nums text-right">{p.sessions}</td>
              <td className="py-2 tabular-nums text-right font-medium">{formatDuration(p.median)}</td>
              <td className="py-2 text-right">
                <Link
                  href={`/session?id=${encodeURIComponent(p.worst.sessionId)}`}
                  className="text-brand hover:underline font-mono text-xs"
                >
                  {p.worst.sessionId.slice(0, 12)}
                </Link>
              </td>
              <td className="py-2 tabular-nums text-right text-muted-foreground">{formatDuration(p.worst.latencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RatioTable({ rows }: { rows: SearchToEditRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-right py-2 font-normal">Reads</th>
          <th className="text-right py-2 font-normal">Edits</th>
          <th className="text-right py-2 font-normal">Ratio</th>
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
            <td className="py-2 tabular-nums text-right">{formatNumber(r.reads)}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.edits)}</td>
            <td className="py-2 tabular-nums text-right">{formatRatio(r.ratio)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatTokens(r.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LatencyTable({ rows }: { rows: FirstActionLatencyRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-right py-2 font-normal">Latency</th>
          <th className="text-right py-2 font-normal">First user msg</th>
          <th className="text-right py-2 font-normal">First action</th>
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
            <td className="py-2 tabular-nums text-right">{formatDuration(r.latencyMs)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{r.firstUserMsgAt.slice(0, 16).replace("T", " ")}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{r.firstActionAt.slice(0, 16).replace("T", " ")}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatTokens(r.tokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
