import { describe, it, expect } from "bun:test";
import { pickAxisLabelInterval } from "../../src/lib/chart-axis";

/**
 * `pickAxisLabelInterval` thins x-axis labels for time-series bar
 * charts so a 90-day window doesn't render a forest of overlapping
 * dates. The number is fed straight to Recharts' `XAxis.interval` prop:
 * 0 = show every tick, N = skip N between ticks.
 *
 * Target: roughly 12 labels visible regardless of bar count, so the
 * eye gets cardinality cues at any range without label collisions.
 */
describe("pickAxisLabelInterval", () => {
  it("shows every label for short ranges", () => {
    expect(pickAxisLabelInterval(0)).toBe(0);
    expect(pickAxisLabelInterval(1)).toBe(0);
    expect(pickAxisLabelInterval(7)).toBe(0);
    expect(pickAxisLabelInterval(14)).toBe(0);
  });

  it("thins as the bar count grows", () => {
    expect(pickAxisLabelInterval(30)).toBeGreaterThanOrEqual(1);
    expect(pickAxisLabelInterval(60)).toBeGreaterThanOrEqual(3);
    expect(pickAxisLabelInterval(90)).toBeGreaterThanOrEqual(5);
    expect(pickAxisLabelInterval(365)).toBeGreaterThanOrEqual(20);
  });

  it("keeps the visible label count bounded as range grows", () => {
    // Visible labels = floor(n / (interval + 1)). Should stay near the
    // target band (8–18) at any plausible range so the axis doesn't
    // collapse to two labels OR explode into a wall of dates.
    for (const n of [30, 60, 90, 180, 365, 730]) {
      const interval = pickAxisLabelInterval(n);
      const visible = Math.floor(n / (interval + 1));
      expect(visible).toBeGreaterThanOrEqual(8);
      expect(visible).toBeLessThanOrEqual(18);
    }
  });

  it("never returns a negative interval (Recharts treats <0 as 'preserveEnd' which we don't want)", () => {
    for (const n of [0, 1, 2, 5, 14, 100]) {
      expect(pickAxisLabelInterval(n)).toBeGreaterThanOrEqual(0);
    }
  });
});
