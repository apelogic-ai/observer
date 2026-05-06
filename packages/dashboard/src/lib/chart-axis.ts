/**
 * Chart axis helpers — kept pure & framework-agnostic so they're
 * easy to unit test without rendering Recharts.
 */

/**
 * Pick a Recharts `XAxis.interval` value that thins time-series labels
 * to roughly 12 visible at any range. Recharts' `preserveEnd` default
 * collapses to ~5 labels at long ranges; we want a denser, predictable
 * cadence so the eye can still read tick→date mapping at 90+ days.
 *
 * Returns 0 (show every label) when there are 14 or fewer bars.
 * Otherwise returns `floor(n / 12) - 1`, clamped to ≥1 — meaning skip
 * that many labels between visible ones.
 */
export function pickAxisLabelInterval(barCount: number): number {
  if (barCount <= 14) return 0;
  return Math.max(1, Math.floor(barCount / 12) - 1);
}
