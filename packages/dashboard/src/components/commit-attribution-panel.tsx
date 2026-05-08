"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { useUnlinkedAgentCommits, type DashboardFilters } from "@/hooks/use-dashboard";
import type { CommitAttributionRow } from "@/lib/queries";

/**
 * Per-project commit-attribution panel. Sits next to the GitStatsCards
 * to show *which* projects contribute the unlinked-agent-commit count
 * — every session-level metric (zero-code, dark-spend, productivity)
 * divides by linked agent commits, so a project that consistently
 * fails to link is silently undercounting downstream.
 *
 * Rows are clickable: expanding a project lists its orphan commits
 * inline, each one linking to /commit?sha=… for a full diff view.
 *
 * Server-side query already orders worst-first (most unlinked, then
 * most total). Hidden when every project is fully linked — the panel
 * only earns its space when there's a gap.
 */
interface Props {
  rows: CommitAttributionRow[];
  filters: DashboardFilters;
}

export function CommitAttributionPanel({ rows, filters }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const projectsWithGap = rows.filter((r) => r.unlinked_agent_commits > 0);
  if (projectsWithGap.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commit attribution by project</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Projects with agent commits that aren&apos;t linking to a session.
          Click a row to list the orphan commits.
        </p>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground border-b border-border">
            <tr>
              <th className="text-left py-2 font-normal w-6"></th>
              <th className="text-left py-2 font-normal">Project</th>
              <th className="text-right py-2 font-normal">Agent commits</th>
              <th className="text-right py-2 font-normal">Linked</th>
              <th className="text-right py-2 font-normal">Unlinked</th>
              <th className="text-right py-2 font-normal">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {projectsWithGap.map((r) => {
              const isOpen = expanded === r.project;
              const pct = r.agent_commits > 0
                ? Math.round((r.linked_agent_commits / r.agent_commits) * 100)
                : 0;
              return (
                <ProjectRowGroup
                  key={r.project}
                  row={r}
                  pct={pct}
                  filters={filters}
                  isOpen={isOpen}
                  onToggle={() => setExpanded(isOpen ? null : r.project)}
                />
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

interface ProjectRowGroupProps {
  row: CommitAttributionRow;
  pct: number;
  filters: DashboardFilters;
  isOpen: boolean;
  onToggle: () => void;
}

function ProjectRowGroup({ row, pct, filters, isOpen, onToggle }: ProjectRowGroupProps) {
  return (
    <>
      <tr
        className="border-b border-border/40 cursor-pointer hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="py-2 text-center text-muted-foreground select-none">{isOpen ? "▼" : "▶"}</td>
        <td className="py-2 font-mono">{row.project}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.agent_commits)}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.linked_agent_commits)}</td>
        <td className="py-2 tabular-nums text-right">{formatNumber(row.unlinked_agent_commits)}</td>
        <td className="py-2 tabular-nums text-right">{pct}%</td>
      </tr>
      {isOpen && (
        <tr>
          <td></td>
          <td colSpan={5} className="pb-3">
            <UnlinkedCommitList project={row.project} filters={filters} />
          </td>
        </tr>
      )}
    </>
  );
}

function UnlinkedCommitList({ project, filters }: { project: string; filters: DashboardFilters }) {
  const commits = useUnlinkedAgentCommits(project, filters);
  if (commits === null) return <div className="text-xs text-muted-foreground py-2">Loading…</div>;
  if (commits.length === 0) return <div className="text-xs text-muted-foreground py-2">No orphan commits in this window.</div>;
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground">
        <tr>
          <th className="text-left py-1 font-normal">Commit</th>
          <th className="text-left py-1 font-normal">Branch</th>
          <th className="text-left py-1 font-normal">Message</th>
          <th className="text-right py-1 font-normal">Files</th>
          <th className="text-right py-1 font-normal">+/−</th>
          <th className="text-right py-1 font-normal">When</th>
        </tr>
      </thead>
      <tbody>
        {commits.map((c) => (
          <tr key={c.commit_sha} className="border-t border-border/30">
            <td className="py-1 font-mono">
              <Link href={`/commit?sha=${encodeURIComponent(c.commit_sha)}`} className="text-brand hover:underline">
                {c.commit_sha.slice(0, 10)}
              </Link>
            </td>
            <td className="py-1 font-mono text-muted-foreground">{c.branch}</td>
            <td className="py-1 max-w-[480px] truncate">{firstLine(c.message)}</td>
            <td className="py-1 tabular-nums text-right">{formatNumber(c.files_changed)}</td>
            <td className="py-1 tabular-nums text-right text-muted-foreground">+{formatNumber(c.insertions)} / −{formatNumber(c.deletions)}</td>
            <td className="py-1 tabular-nums text-right text-muted-foreground">{c.timestamp.slice(0, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}
