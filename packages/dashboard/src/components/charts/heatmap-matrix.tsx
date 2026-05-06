"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_COLORS } from "@/lib/colors";
import { formatDate, formatNumber } from "@/lib/format";
import type { HeatmapRow } from "@/lib/queries";

interface Props {
  data: HeatmapRow[];
  /** Cap rows so a 50-project workspace doesn't explode the layout. */
  maxRows?: number;
  onProjectClick?: (project: string) => void;
}

interface Cell {
  total: number;
  /** Per-agent totals for the tooltip + dominant-color choice. */
  byAgent: Map<string, number>;
}

/**
 * Date × project token-usage matrix. Cell color = dominant agent's color;
 * cell opacity = log-scaled total tokens relative to the busiest cell so a
 * single mega-day doesn't make the rest invisible. Hover for the agent mix.
 */
export function HeatmapMatrix({ data, maxRows = 12, onProjectClick }: Props) {
  const { dates, projects, cells, logMin, logMax } = useMemo(() => {
    const dateSet = new Set<string>();
    const projectTotals = new Map<string, number>();
    const cells = new Map<string, Cell>(); // key = `${project}|${date}`

    for (const r of data) {
      dateSet.add(r.date);
      projectTotals.set(r.project, (projectTotals.get(r.project) ?? 0) + r.total_tokens);
      const key = `${r.project}|${r.date}`;
      const cell = cells.get(key) ?? { total: 0, byAgent: new Map() };
      cell.total += r.total_tokens;
      cell.byAgent.set(r.agent, (cell.byAgent.get(r.agent) ?? 0) + r.total_tokens);
      cells.set(key, cell);
    }

    const dates = [...dateSet].sort();
    const projects = [...projectTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxRows)
      .map(([p]) => p);

    // Stretch opacity across the actual range, not log(0)→log(max).
    // Otherwise a 1M cell and a 400M cell both end up in 0.7–1.0 range
    // because log10(1e6)/log10(4e8) ≈ 0.7 — no visual differentiation.
    let lMin = Infinity, lMax = -Infinity;
    for (const c of cells.values()) {
      if (c.total <= 0) continue;
      const l = Math.log10(c.total);
      if (l < lMin) lMin = l;
      if (l > lMax) lMax = l;
    }
    if (!isFinite(lMin)) { lMin = 0; lMax = 1; }
    return { dates, projects, cells, logMin: lMin, logMax: lMax };
  }, [data, maxRows]);

  const [hover, setHover] = useState<{
    project: string; date: string; cell: Cell; x: number; y: number;
  } | null>(null);

  // The grid scrolls horizontally — keep the project label column
  // pinned to the left while date columns slide. Auto-scroll to the
  // right on mount so today is visible without dragging.
  // Hooks must precede any early return (rules-of-hooks).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stable signature: the rightmost date. Different ranges → different
  // signatures → re-scroll. Hover updates don't change it.
  const datesKey = dates[dates.length - 1] ?? "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [datesKey]);

  if (data.length === 0 || projects.length === 0 || dates.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Project × Time Heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No project-attributed activity in this window.</p>
        </CardContent>
      </Card>
    );
  }

  // Rotate column labels when there are too many to fit horizontally.
  const rotateLabels = dates.length > 14;
  const logSpan = Math.max(0.0001, logMax - logMin);

  function dominantAgent(cell: Cell): string {
    let best = "";
    let bestVal = -1;
    for (const [a, v] of cell.byAgent) {
      if (v > bestVal) { best = a; bestVal = v; }
    }
    return best;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Project × Time Heatmap
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            tokens · cell color = dominant agent · opacity ∝ log(tokens)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <div ref={scrollRef} className="overflow-x-auto">
          <div
            className="grid gap-px"
            // Date columns get a fixed minimum width (28px) so they
            // don't compress to nothing at long ranges. The container
            // scrolls horizontally instead. The label column stays
            // bounded to ~140–180px and gets `position: sticky` per
            // cell so it pins to the left during the scroll.
            style={{
              gridTemplateColumns: `minmax(140px, 180px) repeat(${dates.length}, 28px)`,
            }}
          >
            {/* Header corner — sticky so it stays above the labels.
                Without a background it'd let date headers show through. */}
            <div className="sticky left-0 z-10 bg-card" />
            {dates.map((d) => (
              <div
                key={d}
                className="text-[10px] text-muted-foreground tabular-nums flex items-end justify-center pb-1"
                style={{
                  writingMode: rotateLabels ? "vertical-rl" : "horizontal-tb",
                  transform: rotateLabels ? "rotate(180deg)" : "none",
                  height: rotateLabels ? 56 : 22,
                }}
              >
                {formatDate(d)}
              </div>
            ))}

            {/* One row per project: label cell + N day cells */}
            {projects.flatMap((project) => [
              <button
                key={`${project}__label`}
                type="button"
                className="sticky left-0 z-10 bg-card text-xs text-right pr-2 truncate text-muted-foreground hover:text-foreground"
                title={project}
                onClick={onProjectClick ? () => onProjectClick(project) : undefined}
              >
                {project}
              </button>,
              ...dates.map((d) => {
                const cell = cells.get(`${project}|${d}`);
                if (!cell) {
                  return <div key={`${project}|${d}`} className="h-6 rounded-sm bg-neutral-900/30" />;
                }
                const agent = dominantAgent(cell);
                // Map [logMin, logMax] → [0.15, 1.0] so the dimmest real
                // cell is faintly visible and the brightest sits at full
                // intensity. Empty cells are handled above (skipped).
                const norm = (Math.log10(cell.total) - logMin) / logSpan;
                const opacity = 0.15 + 0.85 * Math.max(0, Math.min(1, norm));
                return (
                  <div
                    key={`${project}|${d}`}
                    className="h-6 rounded-sm cursor-help"
                    style={{ background: AGENT_COLORS[agent] ?? "#8b949e", opacity }}
                    onMouseMove={(e) => setHover({ project, date: d, cell, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              }),
            ])}
          </div>

          </div>
          {/* Right-edge gradient — affordance hint that the grid is
              scrollable horizontally. Pointer-events-none so it doesn't
              eat hover/scroll on the rightmost cells. Visible only when
              there are enough dates to actually overflow. */}
          {dates.length > 14 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
            />
          )}

          {hover && (
            <div
              className="pointer-events-none fixed z-50 rounded-md border border-border bg-neutral-900 p-2 text-xs shadow-lg"
              style={{ left: hover.x + 12, top: hover.y + 12, color: "#fff" }}
            >
              <div className="font-mono text-muted-foreground mb-0.5">
                {hover.project} · {formatDate(hover.date)}
              </div>
              <div className="tabular-nums">{formatNumber(hover.cell.total)} tokens</div>
              <div className="mt-1 space-y-0.5">
                {[...hover.cell.byAgent.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([a, v]) => (
                    <div key={a} className="flex items-center gap-2">
                      <span
                        className="inline-block w-2 h-2 rounded-sm"
                        style={{ background: AGENT_COLORS[a] ?? "#8b949e" }}
                      />
                      <span className="font-mono">{a.replace("_", " ")}</span>
                      <span className="ml-auto tabular-nums">{formatNumber(v)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
