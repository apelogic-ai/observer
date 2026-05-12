import { describe, it, expect } from "bun:test";
import { rollupByProject, median } from "../../src/lib/project-rollup";

/**
 * `rollupByProject` aggregates per-session rows into per-project rows
 * with a median-of-metric and a "worst session" pointer. Used to put a
 * project-level summary on top of the per-session detail tables on
 * Validation / Autonomy / Efficiency / Productivity. Median (not mean)
 * because one 343-read session would otherwise drag a whole project's
 * average to a place no other session in it actually lives.
 */

describe("median", () => {
  it("returns the middle of an odd-length sorted list", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
  });
  it("returns the average of the two middles for even lengths", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("returns 0 for empty input (callers treat 0 as 'no data')", () => {
    expect(median([])).toBe(0);
  });
  it("skips non-finite values", () => {
    expect(median([1, NaN, 3, Infinity])).toBe(2);
  });
});

describe("rollupByProject", () => {
  type Row = { project: string | null; tokens: number; ratio: number };
  const rows: Row[] = [
    { project: "alpha", tokens: 100, ratio: 1 },
    { project: "alpha", tokens: 200, ratio: 3 },
    { project: "alpha", tokens: 5000, ratio: 9 },   // worst
    { project: "beta",  tokens: 50,  ratio: 2 },
    { project: "beta",  tokens: 80,  ratio: 4 },
    { project: null,    tokens: 10,  ratio: 0.5 }, // dropped: unknown project
  ];

  it("groups by project, drops null-project rows", () => {
    const out = rollupByProject(rows, { metric: (r) => r.ratio });
    expect(out.map((p) => p.project).sort()).toEqual(["alpha", "beta"]);
  });

  it("counts sessions per project", () => {
    const out = rollupByProject(rows, { metric: (r) => r.ratio });
    const alpha = out.find((p) => p.project === "alpha")!;
    expect(alpha.sessions).toBe(3);
  });

  it("computes median of the metric", () => {
    const out = rollupByProject(rows, { metric: (r) => r.ratio });
    const alpha = out.find((p) => p.project === "alpha")!;
    expect(alpha.median).toBe(3); // median of [1, 3, 9]
    const beta = out.find((p) => p.project === "beta")!;
    expect(beta.median).toBe(3); // average of [2, 4]
  });

  it("surfaces the worst session per project (max metric)", () => {
    const out = rollupByProject(rows, { metric: (r) => r.ratio });
    const alpha = out.find((p) => p.project === "alpha")!;
    expect(alpha.worst.ratio).toBe(9);
    expect(alpha.worst.tokens).toBe(5000);
  });

  it("sorts projects worst-median first by default", () => {
    const out = rollupByProject(rows, { metric: (r) => r.ratio });
    // alpha median 3, beta median 3 — tied. Tiebreaker: worst metric desc.
    expect(out[0]!.project).toBe("alpha");
  });

  it("can sort by a custom comparator", () => {
    const out = rollupByProject(rows, {
      metric: (r) => r.ratio,
      sort: (a, b) => a.sessions - b.sessions,
    });
    expect(out.map((p) => p.project)).toEqual(["beta", "alpha"]);
  });

  it("supports a secondary metric on each project row", () => {
    const out = rollupByProject(rows, {
      metric: (r) => r.ratio,
      extra: { tokens: (r) => r.tokens },
    });
    const alpha = out.find((p) => p.project === "alpha")!;
    // Sum of tokens across alpha sessions
    expect(alpha.extra.tokens).toBe(5300);
  });
});
