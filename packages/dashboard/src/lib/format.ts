export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  // YYYY-MM-DD bucket labels: build a Date from the parts so we land on
  // local noon, not UTC midnight. Otherwise west-of-UTC users see every
  // date label shifted back one day (UTC midnight = previous-day evening).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
    : new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(startIso: string, endIso: string): string {
  if (!startIso || !endIso) return "-";
  return formatDurationMs(new Date(endIso).getTime() - new Date(startIso).getTime());
}

export function formatDurationMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "-";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}
