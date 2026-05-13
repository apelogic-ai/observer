"use client";

import { useEffect, useState } from "react";
import { useComparison } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { ComparisonBucket, ComparisonResult } from "@/lib/queries";

/**
 * Before / after: split git history at a cutoff date (default the
 * user's first observer-collected agent commit) and show the same
 * set of git-derived metrics on each side. Post also splits human-
 * authored vs agent-authored so you can read three columns:
 * "before AI" / "me, after AI" / "agent, after AI".
 */

interface MetricDef {
  key: keyof ComparisonBucket;
  label: string;
  fmt: (v: number) => string;
  /** Whether higher is better for highlighting. null = neutral. */
  direction?: "up" | "down" | null;
}

const PCT = (v: number) => `${v.toFixed(0)}%`;
const NUM0 = (v: number) => formatNumber(Math.round(v));
const NUM1 = (v: number) => v.toFixed(1);
const NUM2 = (v: number) => v.toFixed(2);

const METRICS: MetricDef[] = [
  { key: "commits",             label: "Commits",              fmt: NUM0 },
  { key: "activeDays",          label: "Active days",          fmt: NUM0 },
  { key: "commitsPerActiveDay", label: "Commits / active day", fmt: NUM2 },
  { key: "medianLocDelta",      label: "LoC delta — median",   fmt: NUM0 },
  { key: "meanLocDelta",        label: "LoC delta — mean",     fmt: NUM0 },
  { key: "medianFiles",         label: "Files / commit — median", fmt: NUM1 },
  { key: "testCommitPct",       label: "Commits touching tests", fmt: PCT },
  { key: "bigCommitPct",        label: "Big commits (>500 LoC)", fmt: PCT },
  { key: "smallCommitPct",      label: "Small commits (<50 LoC)", fmt: PCT },
];

export default function ComparisonPage() {
  const { filters, buildQs } = useFilters();
  const [cutoff, setCutoff] = useState<string>("");
  const [sameReposOnly, setSameReposOnly] = useState<boolean>(true);
  const [appliedCutoff, setAppliedCutoff] = useState<string>("");

  // First render: hit the endpoint with a placeholder cutoff just to
  // discover the user's first agent commit, then snap the input to it.
  useEffect(() => {
    if (cutoff !== "") return;
    fetch(`/api/comparison?cutoff=2000-01-01&sameReposOnly=0`)
      .then((r) => r.json() as Promise<ComparisonResult>)
      .then((d) => {
        const defaultCutoff = d.firstAgentCommitDate ?? "2026-02-01";
        setCutoff(defaultCutoff);
        setAppliedCutoff(defaultCutoff);
      })
      .catch(() => {
        const fallback = "2026-02-01";
        setCutoff(fallback);
        setAppliedCutoff(fallback);
      });
  }, [cutoff]);

  const data = useComparison(appliedCutoff || "2000-01-01", sameReposOnly);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Before / after"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onRefresh={() => window.location.reload()}
      />

      <Card>
        <CardHeader>
          <CardTitle>Split git history at a cutoff date</CardTitle>
          <p className="text-sm text-muted-foreground">
            <strong>What this view answers.</strong> Pick a date — by
            default, your first observer-collected agent commit. Every
            git commit observer has on file is bucketed into pre or
            post; post is further split into human-authored vs
            agent-authored. Same metrics on each side: commits /
            active day, change size, test-touching rate. The cleanest
            comparison is restricted to repos that were active in both
            windows — toggle the filter to widen.
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            <strong>Caveats.</strong> Off-hours patterns and weekday
            mix shift with travel, role changes, and project mix
            independently of any tooling. A 2× jump in commits / day
            can come from &ldquo;I joined a new project&rdquo; as easily as from
            &ldquo;I started using an agent&rdquo; — read across metrics, not one
            row at a time. Test-touching rate is the most resistant to
            confounders.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Cutoff</span>
              <input
                type="date"
                value={cutoff}
                onChange={(e) => setCutoff(e.target.value)}
                className="bg-background border border-border rounded px-2 py-1 text-sm font-mono"
              />
            </label>
            <button
              onClick={() => setAppliedCutoff(cutoff)}
              className="px-3 py-1 text-sm bg-brand text-background rounded hover:opacity-90 disabled:opacity-50"
              disabled={!cutoff || cutoff === appliedCutoff}
            >
              Apply
            </button>
            <label className="flex items-center gap-2 text-sm ml-4">
              <input
                type="checkbox"
                checked={sameReposOnly}
                onChange={(e) => setSameReposOnly(e.target.checked)}
              />
              <span>Restrict post-period to repos active before the cutoff</span>
            </label>
            {data?.firstAgentCommitDate && (
              <span className="text-xs text-muted-foreground ml-auto">
                First agent commit on file: <span className="font-mono">{data.firstAgentCommitDate}</span>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Side-by-side metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {data === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <MetricsTable data={data} />
          )}
        </CardContent>
      </Card>

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>Coverage</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Projects observer has at least one commit for in each window.
              The intersection is the &ldquo;repos active in both&rdquo; set used
              when the filter above is enabled.
            </p>
          </CardHeader>
          <CardContent className="text-sm">
            <RepoList label="Pre-cutoff" repos={data.preRepos} />
            <RepoList label="Post-cutoff" repos={data.postRepos} />
            <RepoList label="Both windows" repos={data.bothWindowRepos} highlight />
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function MetricsTable({ data }: { data: ComparisonResult }) {
  const cols: { key: keyof ComparisonResult; label: string; bucket: ComparisonBucket }[] = [
    { key: "pre",       label: "PRE (before cutoff)",      bucket: data.pre },
    { key: "postHuman", label: "POST — human authored",    bucket: data.postHuman },
    { key: "postAgent", label: "POST — agent authored",    bucket: data.postAgent },
  ];

  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground border-b border-border">
        <tr>
          <th className="text-left py-2 font-normal w-[35%]">Metric</th>
          {cols.map((c) => (
            <th key={String(c.key)} className="text-right py-2 font-normal">{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {METRICS.map((m) => (
          <tr key={String(m.key)} className="border-b border-border/40">
            <td className="py-2 text-muted-foreground">{m.label}</td>
            {cols.map((c) => (
              <td key={String(c.key)} className="py-2 tabular-nums text-right">
                {m.fmt(c.bucket[m.key] as number)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RepoList({ label, repos, highlight }: { label: string; repos: string[]; highlight?: boolean }) {
  return (
    <div className="py-2">
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label} <span className="font-mono normal-case tracking-normal">({repos.length})</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {repos.length === 0 ? (
          <span className="text-muted-foreground text-xs">—</span>
        ) : repos.map((r) => (
          <span
            key={r}
            className={`text-[11px] px-2 py-0.5 rounded border ${highlight ? "border-brand text-brand" : "border-border text-muted-foreground"}`}
          >
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}
