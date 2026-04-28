"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useProjectList, useAgentList } from "@/hooks/use-dashboard";
import type { FilterState, Granularity } from "@/hooks/use-filters";

function prettyAgent(a: string): string {
  return a.replace("_", " ");
}

const RANGES = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "All", value: null },
] as const;

const GRANULARITIES: { label: string; value: Granularity }[] = [
  { label: "Day", value: "day" },
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
];

interface Breadcrumb {
  label: string;
  href: string;
}

interface Props {
  title: string;
  breadcrumbs?: Breadcrumb[];
  filters?: FilterState;
  onDaysChange?: (days: number | null) => void;
  onGranularityChange?: (g: Granularity) => void;
  onProjectChange?: (project: string | null) => void;
  showProjectSelector?: boolean;
  onAgentChange?: (agent: string | null) => void;
  showAgentSelector?: boolean;
  onRefresh?: () => void;
}

export function PageHeader({
  title,
  breadcrumbs,
  filters,
  onDaysChange,
  onGranularityChange,
  onProjectChange,
  showProjectSelector,
  onAgentChange,
  showAgentSelector,
  onRefresh,
}: Props) {
  const projects = useProjectList();
  const agents = useAgentList();

  return (
    <div className="space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {breadcrumbs.map((b, i) => (
            <span key={b.href} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground/50">/</span>}
              <Link href={b.href} className="hover:text-foreground transition-colors">
                {b.label}
              </Link>
            </span>
          ))}
          <span className="text-muted-foreground/50">/</span>
          <span className="text-foreground font-medium">{title}</span>
        </nav>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {filters && (
          <div className="flex items-center gap-3">
            {showProjectSelector && onProjectChange && (
              <select
                value={filters.project ?? ""}
                onChange={(e) => onProjectChange(e.target.value || null)}
                className="h-8 rounded-md border border-border bg-secondary px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            )}
            {showAgentSelector && onAgentChange && (
              <select
                value={filters.agent ?? ""}
                onChange={(e) => onAgentChange(e.target.value || null)}
                className="h-8 rounded-md border border-border bg-secondary px-3 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a} value={a}>{prettyAgent(a)}</option>
                ))}
              </select>
            )}
            {onGranularityChange && (
              <div className="flex gap-1 rounded-lg border border-border p-1">
                {GRANULARITIES.map((g) => (
                  <Button
                    key={g.value}
                    variant={filters.granularity === g.value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => onGranularityChange(g.value)}
                  >
                    {g.label}
                  </Button>
                ))}
              </div>
            )}
            {onDaysChange && (
              <div className="flex gap-1 rounded-lg border border-border p-1">
                {RANGES.map((r) => (
                  <Button
                    key={r.label}
                    variant={filters.days === r.value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-3 text-xs"
                    onClick={() => onDaysChange(r.value)}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>
            )}
            {onRefresh && (
              <Button variant="outline" size="sm" className="h-7" onClick={onRefresh}>
                Refresh
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
