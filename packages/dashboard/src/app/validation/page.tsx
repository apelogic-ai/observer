"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useValidationCoverage } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import type { ValidationCoverageRow } from "@/lib/queries";

/**
 * "Did the agent verify its own work before finishing?" surfaced
 * per-session. Validation = a Bash/shell tool call whose command
 * starts with a known test/lint/typecheck/build invocation
 * (`bun test`, `pytest`, `eslint`, etc.). Edit = Edit/Write/MultiEdit
 * for Claude Code, apply_patch (normalized to "edit") for Codex.
 *
 * Sort: un-validated first, by tokens descending. The expensive
 * flail (high spend, code shipped, no tests run) lands at the top —
 * that's the headline. Once the un-validated block ends, validated
 * sessions follow for context.
 */

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 10);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function ValidationPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const data = useValidationCoverage(filters);

  const summary = useMemo(() => {
    if (!data) return null;
    const total = data.length;
    const validated = data.filter((r) => r.validatedAfterEdit).length;
    const pct = total > 0 ? Math.round((validated / total) * 100) : 0;
    const unvalidatedTokens = data
      .filter((r) => !r.validatedAfterEdit)
      .reduce((acc, r) => acc + r.tokens, 0);
    return { total, validated, unvalidated: total - validated, pct, unvalidatedTokens };
  }, [data]);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Validation"
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
          <CardTitle>Did the agent verify its own work?</CardTitle>
          <p className="text-sm text-muted-foreground">
            For each session that edited code, did a test / lint /
            typecheck / build command run <em>after</em> the last edit?
            A session that edits but never validates — or validates and
            then edits again — is a quality risk: code shipped without
            its own author confirming it works.
          </p>
        </CardHeader>
        {summary && summary.total > 0 && (
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard label="Sessions edited" value={String(summary.total)} />
              <SummaryCard label="Validated after edit" value={`${summary.validated} (${summary.pct}%)`} />
              <SummaryCard label="Un-validated" value={String(summary.unvalidated)} />
              <SummaryCard label="Tokens spent un-validated" value={formatTokens(summary.unvalidatedTokens)} />
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions, ranked by un-validated token spend</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Un-validated sessions first (red), highest token spend at
            the top. Validated sessions appear below for context.
          </p>
        </CardHeader>
        <CardContent>
          {data === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : data.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No sessions edited code in this window.
            </div>
          ) : (
            <ValidationTable rows={data} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function ValidationTable({ rows }: { rows: ValidationCoverageRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-right py-2 font-normal">Tokens</th>
          <th className="text-right py-2 font-normal">Last edit</th>
          <th className="text-right py-2 font-normal">Last validation</th>
          <th className="text-center py-2 font-normal">Validated?</th>
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
            <td className="py-2 tabular-nums text-right">{formatNumber(r.tokens)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{formatRelative(r.lastEditAt)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">
              {r.lastValidationAt ? formatRelative(r.lastValidationAt) : "—"}
            </td>
            <td className="py-2 text-center">
              {r.validatedAfterEdit ? (
                <span className="text-green-500">✓</span>
              ) : (
                <span className="text-orange-500">✗</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
