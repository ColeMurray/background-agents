"use client";

import {
  getCacheHitRatio,
  type AnalyticsBreakdownEntry,
  type AnalyticsDashboardResponse,
} from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatAnalyticsRatio,
  formatCompletionRate,
  getAnalyticsDimensionLabels,
  getCompletionRate,
} from "@/lib/analytics";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

export type AnalyticsCostDimension = "model" | "provider" | "harness" | "automation";

type ExtraColumn = "subscriptionSessions" | "completionRate" | "prs" | "cacheHitRatio";

const DIMENSIONS: Record<
  AnalyticsCostDimension,
  { header: string; extra: ExtraColumn[]; emptyMessage: string }
> = {
  model: {
    header: "Model",
    extra: ["prs", "cacheHitRatio"],
    emptyMessage: "No model data found for this range.",
  },
  provider: {
    header: "Provider",
    extra: ["subscriptionSessions", "cacheHitRatio"],
    emptyMessage: "No provider data found for this range.",
  },
  harness: {
    header: "Harness",
    extra: ["completionRate", "prs", "cacheHitRatio"],
    emptyMessage: "No harness data found for this range.",
  },
  automation: {
    header: "Automation",
    extra: ["completionRate", "prs"],
    emptyMessage: "No automation data found for this range.",
  },
};

const EXTRA_COLUMNS: Record<ExtraColumn, AnalyticsTableColumn<AnalyticsBreakdownEntry>> = {
  subscriptionSessions: {
    id: "subscriptionSessions",
    header: "On subscription",
    align: "right",
    sortValue: (entry) => entry.subscriptionSessions ?? 0,
    cell: (entry) =>
      entry.subscriptionSessions === undefined
        ? "—"
        : formatAnalyticsCount(entry.subscriptionSessions),
  },
  completionRate: {
    id: "completionRate",
    header: "Completion",
    align: "right",
    sortValue: getCompletionRate,
    cell: formatCompletionRate,
  },
  prs: {
    id: "prs",
    header: "PRs",
    align: "right",
    hideBelow: "2xl",
    sortValue: (entry) => entry.prs,
    cell: (entry) => formatAnalyticsCount(entry.prs),
  },
  cacheHitRatio: {
    id: "cacheHitRatio",
    header: "Cache hit",
    align: "right",
    hideBelow: "2xl",
    sortValue: (entry) => getCacheHitRatio(entry) ?? -1,
    cell: (entry) => formatAnalyticsRatio(getCacheHitRatio(entry)),
  },
};

/** Sessions and cost for one dimension, largest spend first. */
export function AnalyticsCostTable({
  dashboard,
  dimension,
  limit,
}: {
  dashboard: AnalyticsDashboardResponse;
  dimension: AnalyticsCostDimension;
  limit?: number;
}) {
  const { header, extra, emptyMessage } = DIMENSIONS[dimension];
  const entries = dashboard.breakdowns[dimension].entries;
  const labels = getAnalyticsDimensionLabels(entries);
  const columns: AnalyticsTableColumn<AnalyticsBreakdownEntry>[] = [
    {
      id: "key",
      header,
      sortValue: (entry) => labels.get(entry.key) ?? entry.key,
      cell: (entry) => (
        <span className="font-medium" title={entry.key}>
          {labels.get(entry.key) ?? entry.key}
        </span>
      ),
    },
    {
      id: "sessions",
      header: "Sessions",
      align: "right",
      sortValue: (entry) => entry.sessions,
      cell: (entry) => formatAnalyticsCount(entry.sessions),
    },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      sortValue: (entry) => entry.cost,
      barValue: (entry) => entry.cost,
      cell: (entry) => formatAnalyticsCost(entry.cost),
    },
    {
      id: "costPerSession",
      header: "Per session",
      align: "right",
      sortValue: (entry) => (entry.sessions > 0 ? entry.cost / entry.sessions : 0),
      cell: (entry) => formatAnalyticsCost(entry.sessions > 0 ? entry.cost / entry.sessions : 0),
    },
    ...extra.map((column) => EXTRA_COLUMNS[column]),
  ];
  return (
    <AnalyticsTable
      label={`Cost by ${dimension}`}
      rows={entries}
      columns={columns}
      rowKey={(entry) => entry.key}
      initialSort={{ columnId: "cost", direction: "desc" }}
      limit={limit}
      emptyMessage={emptyMessage}
    />
  );
}
