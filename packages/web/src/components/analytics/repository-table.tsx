"use client";

import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCost,
  formatAnalyticsCount,
  formatCompletionRate,
  formatRepositoryName,
  getCommonRepositoryOwner,
  getCompletionRate,
} from "@/lib/analytics";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

export function AnalyticsRepositoryTable({
  entries,
  limit,
}: {
  entries: AnalyticsBreakdownEntry[];
  limit?: number;
}) {
  const owner = getCommonRepositoryOwner(entries.map((entry) => entry.key));
  const columns: AnalyticsTableColumn<AnalyticsBreakdownEntry>[] = [
    {
      id: "repository",
      header: "Repository",
      sortValue: (entry) => entry.key,
      cell: (entry) => (
        <span className="font-medium" title={entry.key}>
          {formatRepositoryName(entry.key, owner)}
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
      hideBelow: "md",
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
      hideBelow: "lg",
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
  ];
  return (
    <AnalyticsTable
      label="Sessions by repository"
      rows={entries}
      columns={columns}
      rowKey={(entry) => entry.key}
      initialSort={{ columnId: "sessions", direction: "desc" }}
      limit={limit}
      emptyMessage="No repository data found for this range."
    />
  );
}

/** "All in acme" when every repository shares one owner, which the rows then omit. */
export function getRepositoryOwnerNote(entries: AnalyticsBreakdownEntry[]): string | undefined {
  const owner = getCommonRepositoryOwner(entries.map((entry) => entry.key));
  return owner ? `All in ${owner}` : undefined;
}
