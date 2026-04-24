"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useDashboard } from "@/hooks/use-dashboard";
import { useFilters } from "@/hooks/use-filters";
import { PageHeader } from "@/components/page-header";
import { StatsCards } from "@/components/stats-cards";
import { ActivityChart } from "@/components/charts/activity-chart";
import { TokenChart } from "@/components/charts/token-chart";
import { ToolChart } from "@/components/charts/tool-chart";
import { EntityList } from "@/components/entity-list";
import { SessionsTable } from "@/components/sessions-table";

export default function ModelPage() {
  const modelName = useSearchParams().get("name") ?? "";
  const router = useRouter();
  const { filters, setDays, setGranularity, buildQs } = useFilters();
  const { data, loading, error, refresh } = useDashboard({
    ...filters,
    model: modelName,
  });

  if (!modelName) {
    return (
      <main className="flex-1 p-6 max-w-[1600px] mx-auto w-full">
        <PageHeader title="Model" breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]} />
        <p className="text-muted-foreground">No model specified.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 p-6 space-y-6 max-w-[1600px] mx-auto w-full">
      <PageHeader
        title={modelName}
        breadcrumbs={[{ label: "Overview", href: `/${buildQs()}` }]}
        filters={filters}
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
              filters={{ ...filters, model: modelName }}
              onToolClick={(tool) => router.push(`/tool?name=${encodeURIComponent(tool)}`)}
            />
          </div>
          <EntityList
            title="Projects using this model"
            items={data.projects.map((p) => ({
              name: p.project,
              count: p.entries,
              href: `/project?name=${encodeURIComponent(p.project)}`,
            }))}
          />
          <SessionsTable
            data={data.sessions}
            onProjectClick={(p) => router.push(`/project?name=${encodeURIComponent(p)}`)}
          />
        </>
      )}
    </main>
  );
}
