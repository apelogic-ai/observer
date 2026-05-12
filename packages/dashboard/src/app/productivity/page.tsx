"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useProductivityScore } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";
import { AGENT_COLORS } from "@/lib/colors";
import type { ProductivityScoreRow, ProductivityBucket } from "@/lib/queries";

/**
 * Composite per-session productivity score. Combines every other
 * quality dimension on the dashboard into one bucketed view:
 *
 *   productive               — shipped a commit, ≤2 red flags
 *   expensive-but-productive — shipped a commit, but ≥3 red flags
 *   stuck                    — no commit, has a stuck-test loop
 *   needs-better-setup       — no commit, no stuck loops, but
 *                              friction signals (search ratio,
 *                              intervention, latency, dark-spend)
 *
 * Sessions that never edited code are excluded. The page is meant
 * to be read top-to-bottom: productive examples first to give the
 * reader a baseline, then the bottom three buckets to focus
 * attention on what's broken.
 */

const BUCKET_LABELS: Record<ProductivityBucket, string> = {
  "productive": "Productive",
  "expensive-but-productive": "Expensive but productive",
  "stuck": "Stuck",
  "needs-better-setup": "Needs better setup",
};

const BUCKET_COLORS: Record<ProductivityBucket, string> = {
  "productive": "#22c55e",                  // green
  "expensive-but-productive": "#eab308",    // amber
  "stuck": "#ef4444",                       // red
  "needs-better-setup": "#a855f7",          // purple
};

const RED_FLAG_LABELS: Record<string, string> = {
  "no-validation":      "no validation after edit",
  "stuck-loops":        "stuck test loop",
  "high-intervention":  "high user intervention",
  "high-search-ratio":  "high search-to-edit ratio",
  "slow-first-action":  "slow first useful action",
  "dark-spend":         "dark spend (tokens, no LoC)",
};

const GREEN_FLAG_LABELS: Record<string, string> = {
  "shipped-commit": "shipped commit",
  "validated":      "validated after edit",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export default function ProductivityPage() {
  const { filters, setDays, setAgent, setProject, setGranularity, buildQs } = useFilters();
  const data = useProductivityScore(filters);

  const summary = useMemo(() => {
    if (!data) return null;
    const counts: Record<ProductivityBucket, number> = {
      "productive": 0, "expensive-but-productive": 0,
      "stuck": 0, "needs-better-setup": 0,
    };
    for (const r of data) counts[r.bucket]++;
    return { total: data.length, counts };
  }, [data]);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Productivity"
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
          <CardTitle>Composite score per session</CardTitle>
          <p className="text-sm text-muted-foreground">
            <strong>What&apos;s in this view:</strong> every session in
            the selected window that either edited code (Edit /
            Write / apply_patch) or shipped a linked agent commit.
            Pure-chat and read-only exploration sessions are
            filtered out — they carry no quality signal.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            <strong>How the score is calculated.</strong> Each
            session starts at <span className="font-mono">50</span>.
            Output bonuses: <span className="font-mono">+6</span>{" "}
            per linked commit (capped at 5), up to{" "}
            <span className="font-mono">+8</span> for LoC delivered,{" "}
            <span className="font-mono">+10</span> for a validation
            run after the last edit. Friction penalties:{" "}
            <span className="font-mono">−8</span> per stuck-test loop
            (capped at <span className="font-mono">−24</span>),{" "}
            <span className="font-mono">−8</span> high intervention
            (≥50 user turns), <span className="font-mono">−6</span>{" "}
            high search/edit ratio (≥5×),{" "}
            <span className="font-mono">−5</span> slow first action
            (≥20m), <span className="font-mono">−12</span> dark spend
            (≥1M tokens, ≤5 LoC), <span className="font-mono">−8</span>{" "}
            no post-edit validation. Clamped to 0–100. The bucket
            is derived from the score plus whether the session
            shipped a commit, so the two views can&apos;t disagree.
          </p>
        </CardHeader>
        {summary && summary.total > 0 && (
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(Object.keys(BUCKET_LABELS) as ProductivityBucket[]).map((b) => (
                <div key={b} className="rounded-md border border-border p-3">
                  <div className="text-xs uppercase tracking-wider" style={{ color: BUCKET_COLORS[b] }}>
                    {BUCKET_LABELS[b]}
                  </div>
                  <div className="text-2xl font-bold tabular-nums mt-1">
                    {formatNumber(summary.counts[b])}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions, grouped by bucket</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Productive at the top (baseline of what good looks like),
            then expensive-but-productive, stuck, and
            needs-better-setup. Within each bucket: highest score
            first, then highest tokens.
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
            <ScoreTable rows={data} />
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ScoreTable({ rows }: { rows: ProductivityScoreRow[] }) {
  // Group rows by bucket while preserving the upstream sort order
  // (highest score first within each bucket).
  const groups: { bucket: ProductivityBucket; rows: ProductivityScoreRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.bucket === r.bucket) last.rows.push(r);
    else groups.push({ bucket: r.bucket, rows: [r] });
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal">Session</th>
          <th className="text-left py-2 font-normal">Agent</th>
          <th className="text-left py-2 font-normal">Project</th>
          <th className="text-right py-2 font-normal">Score</th>
          <th className="text-right py-2 font-normal">Commits</th>
          <th className="text-right py-2 font-normal">LoC</th>
          <th className="text-right py-2 font-normal">Tokens</th>
          <th className="text-left py-2 font-normal pl-3">Flags</th>
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.bucket}>
          <tr>
            <td
              colSpan={8}
              className="pt-6 pb-2 text-xs uppercase tracking-wider font-semibold border-b border-border"
              style={{ color: BUCKET_COLORS[g.bucket] }}
            >
              {BUCKET_LABELS[g.bucket]}
              <span className="ml-2 text-muted-foreground font-normal normal-case tracking-normal">
                ({g.rows.length})
              </span>
            </td>
          </tr>
          {g.rows.map((r) => (
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
              <td className="py-2 tabular-nums text-right font-bold" style={{ color: BUCKET_COLORS[r.bucket] }}>
                {r.score}
              </td>
              <td className="py-2 tabular-nums text-right">{formatNumber(r.commits)}</td>
              <td className="py-2 tabular-nums text-right">{formatNumber(r.locDelta)}</td>
              <td className="py-2 tabular-nums text-right text-muted-foreground">{formatTokens(r.tokens)}</td>
              <td className="py-2 pl-3">
                <div className="flex flex-wrap gap-1">
                  {r.greenFlags.map((f) => (
                    <span key={f} className="text-[10px] text-green-500" title={GREEN_FLAG_LABELS[f] ?? f}>
                      ✓ {GREEN_FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
                  {r.redFlags.map((f) => (
                    <span key={f} className="text-[10px] text-orange-500" title={RED_FLAG_LABELS[f] ?? f}>
                      ✗ {RED_FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
