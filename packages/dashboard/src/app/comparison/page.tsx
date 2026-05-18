"use client";

import { useMemo, useState } from "react";
import { useComparisonTimeline } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { ComparisonCommit, ComparisonTimeline } from "@/lib/queries";

/**
 * Before / after with an interactive cutoff slider. The whole commit
 * timeline (slim rows) ships once at page load; dragging the slider
 * recomputes pre/post-human/post-agent buckets in-process so the bars
 * animate live. The fixed orange marker shows the first observer-
 * collected agent commit — handy reference for "where my AI-tooling
 * era began."
 */

interface Bucket {
  commits: number;
  activeDays: number;
  /** null when the bucket has zero commits — division-by-zero
   *  metrics shouldn't pretend to be 0. */
  commitsPerActiveDay: number | null;
  medianLocDelta: number | null;
  testCommitPct: number | null;
  bigCommitPct: number | null;
  smallCommitPct: number | null;
  medianFiles: number | null;
}

const EMPTY_BUCKET: Bucket = {
  commits: 0, activeDays: 0,
  commitsPerActiveDay: null, medianLocDelta: null,
  testCommitPct: null, bigCommitPct: null,
  smallCommitPct: null, medianFiles: null,
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function summarise(commits: ComparisonCommit[]): Bucket {
  if (commits.length === 0) return EMPTY_BUCKET;
  const days = new Set(commits.map((c) => c.ts.slice(0, 10))).size;
  const deltas = commits.map((c) => c.locDelta);
  const filesCounts = commits.map((c) => c.nFiles);
  const withTests = commits.filter((c) => c.hasTest).length;
  const big = commits.filter((c) => c.locDelta > 500).length;
  const small = commits.filter((c) => c.locDelta < 50).length;
  return {
    commits: commits.length,
    activeDays: days,
    commitsPerActiveDay: commits.length / Math.max(1, days),
    medianLocDelta: median(deltas),
    medianFiles: median(filesCounts),
    testCommitPct: (withTests / commits.length) * 100,
    bigCommitPct: (big / commits.length) * 100,
    smallCommitPct: (small / commits.length) * 100,
  };
}


const DAY_MS = 86_400_000;

function dateToDays(iso: string, baseDay: number): number {
  return Math.floor(new Date(iso).getTime() / DAY_MS) - baseDay;
}
function daysToDate(daysSinceBase: number, baseDay: number): string {
  return new Date((baseDay + daysSinceBase) * DAY_MS).toISOString().slice(0, 10);
}

export default function ComparisonPage() {
  const { filters, setProject, setAgent, buildQs } = useFilters();
  const data = useComparisonTimeline(filters);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Timeline"
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
        onProjectChange={setProject}
        showProjectSelector
        onAgentChange={setAgent}
        showAgentSelector
        onRefresh={() => window.location.reload()}
      />

      {data === null ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Loading commit timeline…
          </CardContent>
        </Card>
      ) : (
        <ComparisonView data={data} filters={filters} />
      )}
    </main>
  );
}

interface ComparisonViewProps {
  data: ComparisonTimeline;
  filters: { project?: string | null; agent?: string | null };
}

function ComparisonView({ data, filters }: ComparisonViewProps) {
  const empty = data.commits.length === 0;
  // useState initializer runs once and is allowed to be impure (the
  // react-hooks/purity rule treats it as a side-effecting boundary).
  // Lock `today` to mount-time so the empty-state fallback window
  // doesn't drift while the user is on the page.
  const [todayDay] = useState(() => Math.floor(Date.now() / DAY_MS));

  // When the slice is empty (filter to a project with no commits, or
  // an empty store), fall back to a sensible 90-day window so the
  // slider still has a coordinate system to render against. Nothing
  // is interactable in that state — but the chrome stays put so the
  // user can adjust filters without the whole page vanishing.
  const baseDay = empty ? todayDay - 90 : Math.floor(new Date(data.earliest).getTime() / DAY_MS);
  const lastDay = empty ? todayDay : Math.floor(new Date(data.latest).getTime() / DAY_MS);
  const rangeDays = Math.max(1, lastDay - baseDay);

  const firstAgentDays = data.firstAgentCommitDate
    ? Math.floor(new Date(data.firstAgentCommitDate).getTime() / DAY_MS) - baseDay
    : null;

  // Parent only renders this component once `data` is loaded, so
  // firstAgentDays — derived from data — is known at first paint.
  // Default the slider to it; subsequent drags update naturally.
  const [cutoffDays, setCutoffDays] = useState<number>(firstAgentDays ?? Math.floor(rangeDays / 2));
  const cutoffDate = daysToDate(cutoffDays, baseDay);

  const result = useMemo(() => {
    const pre = data.commits.filter((c) => c.ts.slice(0, 10) < cutoffDate);
    const post = data.commits.filter((c) => c.ts.slice(0, 10) >= cutoffDate);
    const postHuman = post.filter((c) => !c.agent);
    const postAgent = post.filter((c) => c.agent);
    return {
      pre: summarise(pre),
      postHuman: summarise(postHuman),
      postAgent: summarise(postAgent),
    };
  }, [data, cutoffDate]);

  // Per-day commit density for the timeline background. One bar per
  // day; capped at ~120 bars so very long ranges don't blow up the
  // DOM. Bigger time windows aggregate into wider buckets.
  const bins = useMemo(() => {
    const N = Math.min(120, rangeDays + 1);
    const buckets: { agent: number; human: number }[] = Array.from({ length: N }, () => ({ agent: 0, human: 0 }));
    for (const c of data.commits) {
      const d = dateToDays(c.ts.slice(0, 10), baseDay);
      const i = Math.min(N - 1, Math.max(0, Math.floor((d / rangeDays) * (N - 1))));
      if (c.agent) buckets[i]!.agent++;
      else buckets[i]!.human++;
    }
    const max = Math.max(1, ...buckets.map((b) => b.agent + b.human));
    return { buckets, max, N };
  }, [data, baseDay, rangeDays]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <p className="text-sm text-muted-foreground">
            Drag the cutoff. Everything before lands in <strong>pre</strong>;
            everything from the cutoff onward is split into{" "}
            <strong>post — human</strong> and <strong>post — agent</strong>.
            The fixed orange tick marks your first observer-collected
            agent commit.
          </p>
        </CardHeader>
        <CardContent>
          <Timeline
            bins={bins}
            cutoffDays={cutoffDays}
            cutoffDate={cutoffDate}
            firstAgentDays={firstAgentDays}
            firstAgentDate={data.firstAgentCommitDate}
            earliest={empty ? "" : data.earliest.slice(0, 10)}
            latest={empty ? "" : data.latest.slice(0, 10)}
            rangeDays={rangeDays}
            onChange={setCutoffDays}
          />
          {empty && (
            <div className="mt-4 rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground space-y-2">
              {filters.project || filters.agent ? (
                <>
                  <div>
                    No commits in observer&apos;s store match this filter
                    {filters.project ? <> (project: <span className="font-mono">{filters.project}</span>)</> : null}
                    {filters.agent ? <> (agent: <span className="font-mono">{filters.agent}</span>)</> : null}
                    .
                  </div>
                  <div className="text-xs">
                    A project can appear in trace activity (sessions, tokens) without producing commits — exploration, Q&amp;A, branches that didn&apos;t merge, or commits made under another identity all show up there but not here.
                  </div>
                </>
              ) : (
                <>
                  No git events on file yet. Run{" "}
                  <code className="font-mono">observer backfill-git --since YYYY-MM-DD</code>{" "}
                  to ingest history.
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Side-by-side metrics</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Each bar is one bucket of commits drawn from the slider position above.
            Hovering any bar reveals the underlying number.
          </p>
        </CardHeader>
        <CardContent>
          <MetricBars
            pre={result.pre}
            postHuman={result.postHuman}
            postAgent={result.postAgent}
          />
        </CardContent>
      </Card>
    </>
  );
}

interface TimelineProps {
  bins: { buckets: { agent: number; human: number }[]; max: number; N: number };
  cutoffDays: number;
  cutoffDate: string;
  firstAgentDays: number | null;
  firstAgentDate: string | null;
  earliest: string;
  latest: string;
  rangeDays: number;
  onChange: (d: number) => void;
}

function Timeline({ bins, cutoffDays, cutoffDate, firstAgentDays, firstAgentDate, earliest, latest, rangeDays, onChange }: TimelineProps) {
  const cutoffPct = (cutoffDays / rangeDays) * 100;
  const firstAgentPct = firstAgentDays === null ? null : (firstAgentDays / rangeDays) * 100;

  return (
    <div className="space-y-3">
      {/* Density strip */}
      <div className="relative h-16 bg-muted/30 rounded-md overflow-hidden">
        <div className="absolute inset-0 flex items-end">
          {bins.buckets.map((b, i) => {
            const total = b.agent + b.human;
            const totalH = (total / bins.max) * 100;
            const agentH = total === 0 ? 0 : (b.agent / total) * totalH;
            const humanH = totalH - agentH;
            return (
              <div key={i} className="flex-1 flex flex-col-reverse mx-[0.5px]">
                <div style={{ height: `${humanH}%`, background: "var(--color-foreground)", opacity: 0.45 }} />
                <div style={{ height: `${agentH}%`, background: "var(--color-brand, #f97316)", opacity: 0.9 }} />
              </div>
            );
          })}
        </div>
        {/* Fixed first-agent marker */}
        {firstAgentPct !== null && (
          <div
            className="absolute top-0 bottom-0 w-px pointer-events-none"
            style={{ left: `${firstAgentPct}%`, background: "var(--color-brand, #f97316)" }}
            title={`First agent commit: ${firstAgentDate}`}
          >
            <div className="absolute -top-1 -translate-x-1/2 w-2 h-2 rounded-full" style={{ background: "var(--color-brand, #f97316)" }} />
          </div>
        )}
        {/* Live cutoff marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 pointer-events-none"
          style={{ left: `${cutoffPct}%`, background: "var(--color-foreground)" }}
        >
          <div className="absolute -top-1 -translate-x-1/2 w-3 h-3 rounded-sm" style={{ background: "var(--color-foreground)" }} />
        </div>
      </div>

      <div className="relative">
        <input
          type="range"
          min={0}
          max={rangeDays}
          value={cutoffDays}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          // Neutral accent on purpose — orange means "agent" everywhere
          // else on this page (chart bars, density strip, fixed marker).
          // If the slider also rendered orange on its filled side, that
          // would read as "pre = agent," which is the opposite of true.
          className="w-full cursor-pointer"
          style={{ accentColor: "var(--color-muted-foreground, #999)" }}
        />
      </div>

      <div className="flex justify-between text-xs text-muted-foreground font-mono">
        <span>{earliest || "—"}</span>
        <span className="text-foreground">cutoff: {cutoffDate}</span>
        <span>{latest || "—"}</span>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 inline-block" style={{ background: "var(--color-foreground)", opacity: 0.45 }} /> human
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 inline-block" style={{ background: "var(--color-brand, #f97316)" }} /> agent
        </span>
        {firstAgentDate && (
          <span className="ml-auto">
            First agent commit on file:{" "}
            <span className="font-mono text-brand">{firstAgentDate}</span>
          </span>
        )}
      </div>
    </div>
  );
}

interface MetricBarsProps { pre: Bucket; postHuman: Bucket; postAgent: Bucket; }

interface MetricDef {
  key: keyof Bucket;
  label: string;
  /** Optional formatter; defaults to a compact number with one decimal. */
  fmt?: (v: number) => string;
  /** Optional explicit max — useful for percentages so bars stay
   *  comparable across re-renders. */
  max?: number;
}

const METRICS: MetricDef[] = [
  { key: "commits",             label: "Commits",                 fmt: (v) => formatNumber(Math.round(v)) },
  { key: "activeDays",          label: "Active days",             fmt: (v) => formatNumber(Math.round(v)) },
  { key: "commitsPerActiveDay", label: "Commits / active day",    fmt: (v) => v.toFixed(2) },
  { key: "medianLocDelta",      label: "LoC delta — median",      fmt: (v) => formatNumber(Math.round(v)) },
  { key: "medianFiles",         label: "Files / commit — median", fmt: (v) => v.toFixed(1) },
  { key: "testCommitPct",       label: "Commits touching tests",  fmt: (v) => `${v.toFixed(0)}%`, max: 100 },
  { key: "bigCommitPct",        label: "Big commits (>500 LoC)",  fmt: (v) => `${v.toFixed(0)}%`, max: 100 },
  { key: "smallCommitPct",      label: "Small commits (<50 LoC)", fmt: (v) => `${v.toFixed(0)}%`, max: 100 },
];

function MetricBars({ pre, postHuman, postAgent }: MetricBarsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
      {METRICS.map((m) => {
        const v: (number | null)[] = [pre[m.key], postHuman[m.key], postAgent[m.key]];
        const numeric = v.filter((x): x is number => x !== null);
        const max = m.max ?? Math.max(1, ...numeric);
        return (
          <MetricCell
            key={m.key}
            label={m.label}
            fmt={m.fmt!}
            values={v as [number | null, number | null, number | null]}
            max={max}
          />
        );
      })}
    </div>
  );
}

interface MetricCellProps {
  label: string;
  fmt: (v: number) => string;
  values: [number | null, number | null, number | null];
  max: number;
}

function MetricCell({ label, fmt, values, max }: MetricCellProps) {
  // Vertical bars: fixed-height plot area, each bar a column. The
  // PRE / human / agent triple maps onto muted-foreground /
  // foreground / brand — matching the density strip's color story.
  // A null value means "the bucket has zero commits, so this metric
  // is undefined" — we render an explicit "no commits" placeholder
  // instead of a phantom zero-height bar.
  const colors = [
    "var(--color-muted-foreground, #888)",
    "var(--color-foreground)",
    "var(--color-brand, #ef8626)",
  ];
  const opacities = [0.45, 0.55, 1.0];
  const xLabels = ["pre", "human", "agent"];
  const PLOT_HEIGHT = 120;

  return (
    <div className="flex flex-col rounded-md border border-border bg-background/40 p-4">
      <div className="text-base font-semibold tracking-tight text-foreground mb-4">
        {label}
      </div>
      <div className="grid grid-cols-3 gap-2 flex-1">
        {values.map((v, i) => {
          const isEmpty = v === null;
          const pct = isEmpty ? 0 : Math.max(0, Math.min(100, (v! / Math.max(0.0001, max)) * 100));
          return (
            <div key={i} className="flex flex-col items-center">
              <div
                className={[
                  "text-sm font-mono tabular-nums mb-1.5",
                  isEmpty ? "text-muted-foreground/60" : "text-foreground",
                ].join(" ")}
              >
                {isEmpty ? "—" : fmt(v!)}
              </div>
              <div
                className={[
                  "w-full rounded-sm relative flex items-end overflow-hidden",
                  isEmpty
                    ? "bg-transparent border border-dashed border-border/60"
                    : "bg-muted/30",
                ].join(" ")}
                style={{ height: `${PLOT_HEIGHT}px` }}
                title={isEmpty ? "no commits in this bucket" : fmt(v!)}
              >
                {!isEmpty && (
                  <div
                    className="w-full rounded-sm transition-all duration-200 ease-out"
                    style={{
                      height: `${pct}%`,
                      background: colors[i],
                      opacity: opacities[i],
                    }}
                  />
                )}
                {isEmpty && (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground/50 uppercase tracking-wider">
                    no commits
                  </div>
                )}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
                {xLabels[i]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
