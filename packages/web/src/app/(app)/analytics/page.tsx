"use client";

import { useMemo, useState } from "react";
import type { AnalyticsDays } from "@open-inspect/shared";
import { AnalyticsRepoBarChart } from "@/components/analytics/repo-bar-chart";
import { AnalyticsSummaryCards } from "@/components/analytics/summary-cards";
import { AnalyticsTimeseriesChart } from "@/components/analytics/timeseries-chart";
import { AnalyticsUserTable } from "@/components/analytics/user-table";
import { useSidebarContext } from "@/components/sidebar-layout";
import { Badge } from "@/components/ui/badge";
import { SidebarIcon } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAnalyticsDashboard } from "@/hooks/use-analytics";
import {
  ANALYTICS_DAYS,
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_RANGE_LABELS,
  formatAnalyticsCount,
  sortAnalyticsUserEntries,
  type AnalyticsSortDirection,
  type AnalyticsUserSortKey,
} from "@/lib/analytics";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";

export default function AnalyticsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const [days, setDays] = useState<AnalyticsDays>(30);
  const [sortKey, setSortKey] = useState<AnalyticsUserSortKey>("sessions");
  const [sortDirection, setSortDirection] = useState<AnalyticsSortDirection>("desc");
  const { summary, timeseries, repoBreakdown, userBreakdown, loading, error } =
    useAnalyticsDashboard(days);
  const userEntries = userBreakdown?.entries;

  const sortedUserEntries = useMemo(
    () => (userEntries ? sortAnalyticsUserEntries(userEntries, sortKey, sortDirection) : undefined),
    [sortDirection, sortKey, userEntries]
  );
  const hasCachedData = Boolean(
    summary ||
    timeseries?.series?.length ||
    repoBreakdown?.entries?.length ||
    sortedUserEntries?.length
  );

  function handleSort(nextKey: AnalyticsUserSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
      return;
    }

    setSortKey(nextKey);
    setSortDirection(nextKey === "user" ? "asc" : "desc");
  }

  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      <div className="pointer-events-none absolute -right-20 top-8 h-56 w-56 rounded-full bg-accent-muted blur-3xl" />
      <div className="pointer-events-none absolute left-20 top-40 h-40 w-40 rounded-full bg-muted blur-3xl" />

      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-6 sm:p-8">
        <div className="relative z-10 mx-auto max-w-7xl space-y-6">
          <div className="relative overflow-hidden rounded-xl border border-border-muted bg-card px-5 py-5 sm:px-6 sm:py-6">
            <div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 bg-[linear-gradient(135deg,var(--accent-muted),transparent)] opacity-70" />

            <div className="relative flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-border-muted bg-background px-3 py-1 text-xs uppercase tracking-[0.16em] text-secondary-foreground">
                  Usage analytics
                </div>
                <div>
                  <h1 className="text-3xl font-semibold text-foreground">Analytics</h1>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                    Usage metrics across sessions, repositories, and users. PR counts currently
                    reflect pull requests created through the platform&apos;s built-in flow, and
                    legacy sessions may show zero cost, PR, or duration values.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="info">
                    Refreshes every {ANALYTICS_REFRESH_INTERVAL_MS / 1000}s
                  </Badge>
                  <Badge variant="default">Includes legacy sessions</Badge>
                  {summary ? (
                    <Badge variant="pr-open">
                      {formatAnalyticsCount(summary.totalSessions)} sessions in range
                    </Badge>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 xl:w-[18rem]">
                <div className="rounded-lg border border-border-muted bg-background p-4">
                  <div className="text-xs uppercase tracking-[0.16em] text-secondary-foreground">
                    Time range
                  </div>
                  <div className="mt-3">
                    <ToggleGroup
                      type="single"
                      value={String(days)}
                      onValueChange={(value) => {
                        if (!value) return;
                        setDays(Number(value) as AnalyticsDays);
                      }}
                      variant="outline"
                      size="sm"
                      className="grid grid-cols-4 gap-1 rounded-md bg-card p-1"
                    >
                      {ANALYTICS_DAYS.map((range) => (
                        <ToggleGroupItem
                          key={range}
                          value={String(range)}
                          aria-label={ANALYTICS_RANGE_LABELS[range]}
                        >
                          {ANALYTICS_RANGE_LABELS[range]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="mt-3 text-xs leading-5 text-muted-foreground">
                    All charts and tables re-filter instantly when the selected range changes.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
            >
              Analytics failed to load. The page will retry automatically, or you can refresh.
            </div>
          ) : null}

          {!error || hasCachedData ? (
            <>
              <AnalyticsSummaryCards days={days} summary={summary} loading={loading} />

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
                <AnalyticsTimeseriesChart series={timeseries?.series} loading={loading} />
                <AnalyticsRepoBarChart entries={repoBreakdown?.entries} loading={loading} />
              </div>

              <AnalyticsUserTable
                entries={sortedUserEntries}
                loading={loading}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={handleSort}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
