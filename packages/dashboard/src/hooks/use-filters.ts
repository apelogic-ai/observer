"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback, useMemo } from "react";

export type Granularity = "day" | "week" | "month";

export interface FilterState {
  days: number | null;
  project: string | null;
  granularity: Granularity;
}

function parseGranularity(v: string | null): Granularity {
  if (v === "week" || v === "month") return v;
  return "day";
}

export function useFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters: FilterState = useMemo(() => {
    const daysParam = searchParams.get("days");
    return {
      days: daysParam === "" || daysParam === "all" ? null : daysParam ? parseInt(daysParam, 10) : 30,
      project: searchParams.get("project") || null,
      granularity: parseGranularity(searchParams.get("granularity")),
    };
  }, [searchParams]);

  const updateParams = useCallback(
    (updates: Partial<FilterState>) => {
      const p = new URLSearchParams(searchParams.toString());
      if ("days" in updates) {
        if (updates.days === null) p.set("days", "all");
        else if (updates.days === 30) p.delete("days"); // 30 is default
        else p.set("days", String(updates.days));
      }
      if ("project" in updates) {
        if (updates.project) p.set("project", updates.project);
        else p.delete("project");
      }
      if ("granularity" in updates) {
        if (updates.granularity === "day") p.delete("granularity"); // day is default
        else p.set("granularity", updates.granularity!);
      }
      const qs = p.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const setDays = useCallback((days: number | null) => updateParams({ days }), [updateParams]);
  const setProject = useCallback((project: string | null) => updateParams({ project }), [updateParams]);
  const setGranularity = useCallback((granularity: Granularity) => updateParams({ granularity }), [updateParams]);

  /** Build query string preserving current filter state, with optional overrides. */
  const buildQs = useCallback(
    (overrides?: Partial<FilterState>): string => {
      const merged = { ...filters, ...overrides };
      const p = new URLSearchParams();
      if (merged.days !== null && merged.days !== 30) p.set("days", String(merged.days));
      if (merged.days === null) p.set("days", "all");
      if (merged.project) p.set("project", merged.project);
      if (merged.granularity !== "day") p.set("granularity", merged.granularity);
      const s = p.toString();
      return s ? `?${s}` : "";
    },
    [filters],
  );

  return { filters, setDays, setProject, setGranularity, buildQs };
}
