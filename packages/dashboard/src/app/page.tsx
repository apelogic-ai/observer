"use client";

import { useRouter } from "next/navigation";
import { useDashboard, useGitData } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { StatsCards } from "@/components/stats-cards";
import { ActivityChart } from "@/components/charts/activity-chart";
import { TokenChart } from "@/components/charts/token-chart";
import { ToolChart } from "@/components/charts/tool-chart";
import { ProjectChart } from "@/components/charts/project-chart";
import { ModelChart } from "@/components/charts/model-chart";
import { SessionsTable } from "@/components/sessions-table";
import { GitStatsCards } from "@/components/git-stats-cards";
import { GitActivityChart } from "@/components/charts/git-activity-chart";
import { GitCommitsTable } from "@/components/git-commits-table";

export default function DashboardPage() {
  const router = useRouter();
  const { filters, setDays, setProject, setGranularity } = useFilters();
  const { data, loading, error, refresh } = useDashboard(filters);
  const { data: gitData } = useGitData(filters);

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title="Overview"
        filters={filters}
        onDaysChange={setDays}
        onProjectChange={setProject}
        onGranularityChange={setGranularity}
        showProjectSelector
        onRefresh={refresh}
      />

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Loading...
        </div>
      )}

      {data && (
        <>
          <StatsCards stats={data.stats} />
          <ActivityChart data={data.activity} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TokenChart data={data.tokens} />
            <ToolChart
              data={data.tools}
              skills={data.skills}
              filters={filters}
              onToolClick={(tool) => router.push(`/tool?name=${encodeURIComponent(tool)}`)}
            />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ProjectChart
              data={data.projects}
              onProjectClick={(p) => router.push(`/project?name=${encodeURIComponent(p)}`)}
            />
            <ModelChart
              data={data.models}
              onModelClick={(m) => router.push(`/model?name=${encodeURIComponent(m)}`)}
            />
          </div>
          <SessionsTable
            data={data.sessions}
            onProjectClick={(p) => router.push(`/project?name=${encodeURIComponent(p)}`)}
          />
        </>
      )}

      {gitData && gitData.stats.total_commits > 0 && (
        <>
          <div className="border-t border-border pt-6">
            <h2 className="text-lg font-semibold mb-4">Git Activity</h2>
          </div>
          <GitStatsCards stats={gitData.stats} />
          <GitActivityChart data={gitData.timeline} />
          <GitCommitsTable
            data={gitData.commits}
            onProjectClick={(p) => router.push(`/project?name=${encodeURIComponent(p)}`)}
            onCommitClick={(sha) => router.push(`/commit?sha=${sha}`)}
          />
        </>
      )}
    </main>
  );
}
