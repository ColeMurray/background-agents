"use client";

import { useMemo } from "react";
import type {
  AnalyticsBreakdownEntry,
  AnalyticsDashboardResponse,
} from "@open-inspect/shared/types/analytics";
import {
  ANALYTICS_UNKNOWN_USER_KEY,
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatAnalyticsDuration,
  formatCompletionRate,
  getCompletionRate,
  getDailySessionCountsByUser,
} from "@/lib/analytics";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { AnalyticsSparkline } from "./analytics-kpis";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

/**
 * Usage per person, with a daily-sessions sparkline each: small multiples in
 * place of one chart with a line per person.
 */
export function AnalyticsPeopleTable({
  dashboard,
  limit,
}: {
  dashboard: AnalyticsDashboardResponse;
  limit?: number;
}) {
  const entries = dashboard.breakdowns.user.entries;
  const activity = useMemo(() => getDailySessionCountsByUser(dashboard), [dashboard]);
  const columns: AnalyticsTableColumn<AnalyticsBreakdownEntry>[] = [
    {
      id: "user",
      header: "User",
      sortValue: (entry) => entry.displayName ?? entry.key,
      cell: (entry) => <PersonCell entry={entry} />,
    },
    {
      id: "activity",
      header: "Daily sessions",
      hideBelow: "md",
      cell: (entry) => (
        <span className="block w-32">
          <AnalyticsSparkline values={activity.get(entry.key) ?? []} height={20} />
        </span>
      ),
    },
    {
      id: "sessions",
      header: "Sessions",
      align: "right",
      sortValue: (entry) => entry.sessions,
      barValue: (entry) => entry.sessions,
      cell: (entry) => formatAnalyticsCount(entry.sessions),
    },
    {
      id: "completionRate",
      header: "Completion",
      align: "right",
      sortValue: getCompletionRate,
      cell: formatCompletionRate,
    },
    {
      id: "prs",
      header: "PRs",
      align: "right",
      sortValue: (entry) => entry.prs,
      cell: (entry) => formatAnalyticsCount(entry.prs),
    },
    {
      id: "messageCount",
      header: "Messages",
      align: "right",
      hideBelow: "xl",
      sortValue: (entry) => entry.messageCount,
      cell: (entry) => formatAnalyticsCount(entry.messageCount),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      sortValue: (entry) => entry.cost,
      cell: (entry) => formatAnalyticsCost(entry.cost),
    },
    {
      id: "avgDuration",
      header: "Avg duration",
      align: "right",
      hideBelow: "lg",
      sortValue: (entry) => entry.avgDuration,
      cell: (entry) => (entry.avgDuration > 0 ? formatAnalyticsDuration(entry.avgDuration) : "—"),
    },
    {
      id: "lastActive",
      header: "Last active",
      align: "right",
      hideBelow: "sm",
      sortValue: (entry) => entry.lastActive,
      cell: (entry) => (
        <span className="text-muted-foreground">{formatRelativeTime(entry.lastActive)}</span>
      ),
    },
  ];

  return (
    <AnalyticsTable
      label="Usage by person"
      rows={entries}
      columns={columns}
      rowKey={(entry) => entry.key}
      initialSort={{ columnId: "sessions", direction: "desc" }}
      limit={limit}
      emptyMessage="No user analytics found for this range."
    />
  );
}

function PersonCell({ entry }: { entry: AnalyticsBreakdownEntry }) {
  const unknown = entry.key === ANALYTICS_UNKNOWN_USER_KEY;
  const name = entry.displayName ?? entry.key;
  return (
    <span className="flex min-w-[10rem] items-center gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
          unknown ? "bg-muted text-muted-foreground" : "bg-accent-muted text-foreground"
        )}
      >
        {name[0]?.toUpperCase() ?? "?"}
      </span>
      <span className="min-w-0">
        <span className={cn("block truncate", unknown && "text-muted-foreground")}>{name}</span>
        {unknown ? (
          <span className="block text-xs text-muted-foreground">Sessions without linked user</span>
        ) : null}
      </span>
    </span>
  );
}
