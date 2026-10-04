"use client";

import { Suspense, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AnalyticsCostTab } from "@/components/analytics/analytics-cost-tab";
import { AnalyticsHeader } from "@/components/analytics/analytics-header";
import { AnalyticsOverviewTab } from "@/components/analytics/analytics-overview-tab";
import { AnalyticsPeopleTab } from "@/components/analytics/analytics-people-tab";
import { AnalyticsPullRequestsTab } from "@/components/analytics/analytics-pull-requests-tab";
import { AnalyticsUsageTab } from "@/components/analytics/analytics-usage-tab";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAnalyticsDashboard } from "@/hooks/use-analytics";
import {
  ANALYTICS_TAB_LABELS,
  ANALYTICS_TABS,
  buildAnalyticsSearch,
  parseAnalyticsView,
  type AnalyticsTab,
  type AnalyticsView,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsContent />
    </Suspense>
  );
}

function AnalyticsContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = parseAnalyticsView(searchParams);
  const { dashboard, loading, stale, validating, error } = useAnalyticsDashboard(
    view.days,
    view.scope
  );
  // Waiting on the selected filters, versus left with the previous ones after a failure.
  const freshness = !stale ? "current" : validating ? "loading" : "previous";
  const scrollRef = useRef<HTMLDivElement>(null);
  const filterKey = `${view.days}-${view.scope}`;

  function changeView(change: Partial<AnalyticsView>) {
    // Build on the address bar, not the last rendered params: replaceState updates it
    // synchronously, so quick successive changes compose instead of overwriting each other.
    // Next syncs useSearchParams with native history calls, but only when the state passed
    // is not its own (it skips state marked as internal), so pass null as its docs do.
    const query = buildAnalyticsSearch(new URLSearchParams(window.location.search), change);
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
  }

  function selectTab(tab: AnalyticsTab) {
    changeView({ tab });
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  return (
    <Tabs
      value={view.tab}
      onValueChange={(value) => {
        const tab = ANALYTICS_TABS.find((candidate) => candidate === value);
        if (tab) selectTab(tab);
      }}
      className="h-full"
    >
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <AnalyticsHeader
          dashboard={dashboard}
          days={view.days}
          scope={view.scope}
          onDaysChange={(days) => changeView({ days })}
          onScopeChange={(scope) => changeView({ scope })}
          scopeDisabled={view.tab === "pull-requests"}
          freshness={freshness}
          tabs={
            <TabsList
              aria-label="Analytics views"
              className="-mb-px min-w-0 gap-5 overflow-x-auto border-b-0"
            >
              {ANALYTICS_TABS.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  className="min-h-0 flex-none px-0 py-2 text-sm font-normal data-[state=inactive]:hover:bg-transparent"
                >
                  {ANALYTICS_TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
          }
        />

        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {error ? (
            <ErrorBanner role="alert" className="mb-4">
              {freshness === "previous"
                ? "Analytics for the selected range and scope failed to load. The previous selection is shown, dimmed, while the page retries."
                : "Analytics failed to load. The page will retry automatically, or you can refresh."}
            </ErrorBanner>
          ) : null}

          {dashboard ? (
            // A snapshot for other filters stays dimmed until the selected one arrives.
            <div
              aria-busy={freshness === "loading"}
              className={cn("transition-opacity", stale && "opacity-60")}
            >
              <TabsContent value="overview">
                <AnalyticsOverviewTab dashboard={dashboard} onSelectTab={selectTab} />
              </TabsContent>
              <TabsContent value="usage">
                <AnalyticsUsageTab dashboard={dashboard} filterKey={filterKey} />
              </TabsContent>
              <TabsContent value="cost">
                <AnalyticsCostTab dashboard={dashboard} />
              </TabsContent>
              <TabsContent value="pull-requests">
                <AnalyticsPullRequestsTab dashboard={dashboard} />
              </TabsContent>
              <TabsContent value="people">
                <AnalyticsPeopleTab dashboard={dashboard} filterKey={filterKey} />
              </TabsContent>
            </div>
          ) : loading ? (
            <AnalyticsLoading />
          ) : null}
        </main>
      </div>
    </Tabs>
  );
}

function AnalyticsLoading() {
  return (
    <div role="status" aria-label="Loading analytics" className="animate-pulse space-y-6">
      <div className="h-28 rounded-lg bg-muted" />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-64 rounded-lg bg-muted" />
        <div className="h-64 rounded-lg bg-muted" />
      </div>
    </div>
  );
}
