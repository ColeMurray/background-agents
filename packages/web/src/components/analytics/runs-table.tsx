"use client";

import Link from "next/link";
import type { AnalyticsDashboardResponse, SessionRun } from "@open-inspect/shared/types/analytics";
import {
  ANALYTICS_SOURCE_LABELS,
  formatAnalyticsCompactCount,
  formatAnalyticsCost,
  formatAnalyticsCount,
} from "@/lib/analytics";
import { formatRelativeTime } from "@/lib/time";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

/** The costliest runs: a root session plus every sub-session it spawned. */
export function AnalyticsRunsTable({
  dashboard,
  limit,
}: {
  dashboard: AnalyticsDashboardResponse;
  limit?: number;
}) {
  const userNames = new Map(
    dashboard.breakdowns.user.entries.map((entry) => [entry.key, entry.displayName ?? entry.key])
  );
  const columns: AnalyticsTableColumn<SessionRun>[] = [
    {
      id: "title",
      header: "Run",
      cell: (run) => (
        <span className="block min-w-[12rem] max-w-[24rem]">
          <Link
            href={`/session/${run.rootSessionId}`}
            className="block truncate font-medium hover:text-accent hover:underline"
          >
            {run.title ?? "Untitled session"}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">
            {[
              userNames.get(run.userId ?? run.scmLogin ?? ""),
              ANALYTICS_SOURCE_LABELS[run.spawnSource],
              run.repoName,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      ),
    },
    {
      id: "sessionCount",
      header: "Sessions",
      align: "right",
      sortValue: (run) => run.sessionCount,
      cell: (run) => formatAnalyticsCount(run.sessionCount),
    },
    {
      id: "maxSpawnDepth",
      header: "Depth",
      align: "right",
      hideBelow: "xl",
      sortValue: (run) => run.maxSpawnDepth,
      cell: (run) => formatAnalyticsCount(run.maxSpawnDepth),
    },
    {
      id: "totalPrs",
      header: "PRs",
      align: "right",
      sortValue: (run) => run.totalPrs,
      cell: (run) => formatAnalyticsCount(run.totalPrs),
    },
    {
      id: "tokens",
      header: "Input + output tokens",
      align: "right",
      hideBelow: "lg",
      sortValue: (run) => run.inputTokens + run.outputTokens,
      cell: (run) => formatAnalyticsCompactCount(run.inputTokens + run.outputTokens),
    },
    {
      id: "totalCost",
      header: "Cost",
      align: "right",
      sortValue: (run) => run.totalCost,
      cell: (run) => formatAnalyticsCost(run.totalCost),
    },
    {
      id: "createdAt",
      header: "Started",
      align: "right",
      hideBelow: "sm",
      sortValue: (run) => run.createdAt,
      cell: (run) => (
        <span className="text-muted-foreground">{formatRelativeTime(run.createdAt)}</span>
      ),
    },
  ];
  return (
    <AnalyticsTable
      label="Most expensive runs"
      rows={dashboard.runs}
      columns={columns}
      rowKey={(run) => run.rootSessionId}
      limit={limit}
      emptyMessage="No runs found for this range."
    />
  );
}
