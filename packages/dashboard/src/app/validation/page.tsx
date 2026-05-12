"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useValidationCoverage, useValidationLoops } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import { rollupByProject, type ProjectRollup } from "@/lib/project-rollup";
import type { ValidationCoverageRow, ValidationLoopRow } from "@/lib/queries";

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
  const loops = useValidationLoops(filters);

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

  // Per-project coverage. Headline metric is "% validated" — lower is
  // worse — so we sort ascending. Worst session = the unvalidated row
  // with the most tokens (the most expensive flail).
  const byProject = useMemo(() => {
    if (!data) return null;
    const groups = new Map<string, ValidationCoverageRow[]>();
    for (const r of data) {
      if (!r.project) continue;
      const list = groups.get(r.project) ?? [];
      list.push(r);
      groups.set(r.project, list);
    }
    const rows = [...groups.entries()].map(([project, list]) => {
      const validated = list.filter((r) => r.validatedAfterEdit).length;
      const unvalidated = list.filter((r) => !r.validatedAfterEdit);
      const pct = list.length > 0 ? Math.round((validated / list.length) * 100) : 0;
      const worst = unvalidated.length > 0
        ? unvalidated.reduce((a, b) => (b.tokens > a.tokens ? b : a))
        : null;
      const unvalidatedTokens = unvalidated.reduce((acc, r) => acc + r.tokens, 0);
      return { project, sessions: list.length, validated, unvalidated: unvalidated.length, pct, worst, unvalidatedTokens };
    });
    rows.sort((a, b) => {
      if (a.pct !== b.pct) return a.pct - b.pct;
      return b.unvalidatedTokens - a.unvalidatedTokens;
    });
    return rows;
  }, [data]);

  const loopsByProject = useMemo(() => {
    if (!loops) return null;
    return rollupByProject(loops, {
      metric: (r) => r.failures,
      extra: { attempts: (r) => r.attempts, failures: (r) => r.failures },
    });
  }, [loops]);

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

      {byProject && byProject.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By project</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              % of edited sessions that ran a validation command after
              the last edit, lowest-coverage-first. Worst session is
              the un-validated row with the highest token spend.
            </p>
          </CardHeader>
          <CardContent>
            <CoverageProjectTable rows={byProject} />
          </CardContent>
        </Card>
      )}

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

      <Card>
        <CardHeader>
          <CardTitle>Stuck-test loops</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            The same validation command running ≥3 times in one
            session. When most attempts fail, that&apos;s the
            T → E → T → E shape of an agent stuck on a red test —
            a different signal from generic stumbles, since here we
            know the call was a test or lint and we know how it
            resolved. Sorted failures first.
          </p>
        </CardHeader>
      </Card>

      {loopsByProject && loopsByProject.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By project</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Per project: loop count, total attempts, total failures.
              Worst loop is the (command, session) pair with the most
              failures.
            </p>
          </CardHeader>
          <CardContent>
            <LoopsProjectTable rows={loopsByProject} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Loops, ranked by failures</CardTitle>
        </CardHeader>
        <CardContent>
          {loops === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : loops.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No validation loops in this window.
            </div>
          ) : (
            <LoopsTable rows={loops} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

interface CoverageProjectRow {
  project: string;
  sessions: number;
  validated: number;
  unvalidated: number;
  pct: number;
  worst: ValidationCoverageRow | null;
  unvalidatedTokens: number;
}

function CoverageProjectTable({ rows }: { rows: CoverageProjectRow[] }) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-2 font-normal">Project</th>
            <th className="text-right py-2 font-normal">Sessions</th>
            <th className="text-right py-2 font-normal">Validated</th>
            <th className="text-right py-2 font-normal">Un-validated tokens</th>
            <th className="text-right py-2 font-normal">Worst session</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.project} className="border-b border-border/40">
              <td className="py-2">{p.project}</td>
              <td className="py-2 tabular-nums text-right">{p.sessions}</td>
              <td className="py-2 tabular-nums text-right font-medium">
                <span className={p.pct >= 50 ? "text-green-500" : "text-orange-500"}>
                  {p.pct}%
                </span>
                <span className="text-muted-foreground"> ({p.validated}/{p.sessions})</span>
              </td>
              <td className="py-2 tabular-nums text-right text-muted-foreground">{formatTokens(p.unvalidatedTokens)}</td>
              <td className="py-2 text-right">
                {p.worst ? (
                  <Link
                    href={`/session?id=${encodeURIComponent(p.worst.sessionId)}`}
                    className="text-brand hover:underline font-mono text-xs"
                  >
                    {p.worst.sessionId.slice(0, 12)}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoopsProjectTable({ rows }: { rows: ProjectRollup<ValidationLoopRow, { attempts: number; failures: number }>[] }) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-2 font-normal">Project</th>
            <th className="text-right py-2 font-normal">Loops</th>
            <th className="text-right py-2 font-normal">Total attempts</th>
            <th className="text-right py-2 font-normal">Total failures</th>
            <th className="text-right py-2 font-normal">Worst loop</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.project} className="border-b border-border/40">
              <td className="py-2">{p.project}</td>
              <td className="py-2 tabular-nums text-right">{p.sessions}</td>
              <td className="py-2 tabular-nums text-right text-muted-foreground">{formatNumber(p.extra.attempts)}</td>
              <td className="py-2 tabular-nums text-right text-orange-500 font-medium">{formatNumber(p.extra.failures)}</td>
              <td className="py-2 font-mono text-xs text-right text-muted-foreground max-w-[400px] truncate">
                {p.worst.command} ({p.worst.failures}/{p.worst.attempts})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoopsTable({ rows }: { rows: ValidationLoopRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-left py-2 font-normal">Command</th>
          <th className="text-right py-2 font-normal">Attempts</th>
          <th className="text-right py-2 font-normal">Failures</th>
          <th className="text-right py-2 font-normal">When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.sessionId}\t${r.command}`} className="border-b border-border/40">
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
            <td className="py-2 font-mono text-xs max-w-[420px] truncate">{r.command}</td>
            <td className="py-2 tabular-nums text-right">{formatNumber(r.attempts)}</td>
            <td className="py-2 tabular-nums text-right text-orange-500">{formatNumber(r.failures)}</td>
            <td className="py-2 tabular-nums text-right text-muted-foreground">{r.startedAt.slice(0, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
