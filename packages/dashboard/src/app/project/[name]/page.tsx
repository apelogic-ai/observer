"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useDashboard } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { StatsCards } from "@/components/stats-cards";
import { ActivityChart } from "@/components/charts/activity-chart";
import { TokenChart } from "@/components/charts/token-chart";
import { ToolChart } from "@/components/charts/tool-chart";
import { ModelChart } from "@/components/charts/model-chart";
import { SessionsTable } from "@/components/sessions-table";

export default function ProjectPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const projectName = decodeURIComponent(name);
  const router = useRouter();
  const { filters, setDays, setGranularity, buildQs } = useFilters();
  const { data, loading, error, refresh } = useDashboard({
    ...filters,
    project: projectName,
  });

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title={projectName}
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={{ ...filters, project: projectName }}
        onDaysChange={setDays}
        onGranularityChange={setGranularity}
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
              filters={{ ...filters, project: projectName }}
              onToolClick={(tool) => router.push(`/tool/${encodeURIComponent(tool)}${buildQs()}`)}
            />
          </div>
          <ModelChart
            data={data.models}
            onModelClick={(m) => router.push(`/model/${encodeURIComponent(m)}${buildQs()}`)}
          />
          <SessionsTable data={data.sessions} />
        </>
      )}
    </main>
  );
}
