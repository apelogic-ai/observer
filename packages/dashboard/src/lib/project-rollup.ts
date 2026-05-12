/**
 * Per-project rollup of per-session rows. Used to put a project-level
 * summary on top of the per-session tables on Validation / Autonomy /
 * Efficiency / Productivity. Median (not mean) because one outlier
 * session would otherwise drag a project's average to a place no other
 * session in it actually lives — the friction signal we want lives in
 * the typical session, not the spike.
 */

export function median(xs: readonly number[]): number {
  const sorted = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ProjectRollup<T, E extends Record<string, number> = Record<string, number>> {
  project: string;
  sessions: number;
  /** Median of the primary metric across sessions in this project. */
  median: number;
  /** Session with the highest metric value — surfaced so an outlier
   *  isn't hidden by the median. */
  worst: T;
  /** Sums of the metrics passed via `extra`. */
  extra: E;
}

interface ProjectKeyed {
  project: string | null;
}

type ExtraFns<T> = Record<string, (r: T) => number>;
type ExtraOf<F> = { [K in keyof F]: number };

export interface RollupOpts<T, F extends ExtraFns<T>> {
  metric: (r: T) => number;
  /** Optional named per-row metrics summed across the project. */
  extra?: F;
  /** Defaults to worst-first (highest median, then highest worst). */
  sort?: (a: ProjectRollup<T, ExtraOf<F>>, b: ProjectRollup<T, ExtraOf<F>>) => number;
}

export function rollupByProject<T extends ProjectKeyed, F extends ExtraFns<T> = ExtraFns<T>>(
  rows: readonly T[],
  opts: RollupOpts<T, F>,
): ProjectRollup<T, ExtraOf<F>>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.project) continue;
    const list = groups.get(r.project) ?? [];
    list.push(r);
    groups.set(r.project, list);
  }

  const out: ProjectRollup<T, ExtraOf<F>>[] = [];
  for (const [project, list] of groups) {
    const metrics = list.map((r) => opts.metric(r));
    let worst = list[0]!;
    let worstMetric = opts.metric(worst);
    for (const r of list) {
      const m = opts.metric(r);
      if (m > worstMetric) {
        worst = r;
        worstMetric = m;
      }
    }
    const extra = {} as ExtraOf<F>;
    if (opts.extra) {
      for (const k of Object.keys(opts.extra) as (keyof F)[]) {
        const fn = opts.extra[k];
        let sum = 0;
        for (const r of list) sum += fn(r);
        (extra as Record<keyof F, number>)[k] = sum;
      }
    }
    out.push({
      project,
      sessions: list.length,
      median: median(metrics),
      worst,
      extra,
    });
  }

  const sort = opts.sort ?? ((a, b) => {
    if (a.median !== b.median) return b.median - a.median;
    return opts.metric(b.worst) - opts.metric(a.worst);
  });
  out.sort(sort);
  return out;
}
