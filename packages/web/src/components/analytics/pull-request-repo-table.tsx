"use client";

import type { AnalyticsPullRequestRepoEntry } from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCount,
  formatAnalyticsLongDuration,
  formatPullRequestAcceptanceRate,
  formatRepositoryName,
  getCommonRepositoryOwner,
  getPullRequestAcceptanceRate,
} from "@/lib/analytics";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

/** Outcomes per repository for the PRs opened in the window. */
export function AnalyticsPullRequestRepoTable({
  entries,
  limit,
}: {
  entries: AnalyticsPullRequestRepoEntry[];
  limit?: number;
}) {
  const owner = getCommonRepositoryOwner(entries.map((entry) => entry.key));
  const columns: AnalyticsTableColumn<AnalyticsPullRequestRepoEntry>[] = [
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
      id: "created",
      header: "Opened",
      align: "right",
      sortValue: (entry) => entry.created,
      barValue: (entry) => entry.created,
      cell: (entry) => formatAnalyticsCount(entry.created),
    },
    {
      id: "merged",
      header: "Merged",
      align: "right",
      sortValue: (entry) => entry.merged,
      cell: (entry) => formatAnalyticsCount(entry.merged),
    },
    {
      id: "closed",
      header: "Closed",
      align: "right",
      hideBelow: "2xl",
      sortValue: (entry) => entry.closed,
      cell: (entry) => formatAnalyticsCount(entry.closed),
    },
    {
      id: "acceptance",
      header: "Acceptance",
      align: "right",
      sortValue: getPullRequestAcceptanceRate,
      cell: formatPullRequestAcceptanceRate,
    },
    {
      id: "avgTimeToMerge",
      header: "Avg time to merge",
      align: "right",
      hideBelow: "md",
      sortValue: (entry) => entry.avgTimeToMergeMs,
      cell: (entry) =>
        entry.avgTimeToMergeMs === null ? "—" : formatAnalyticsLongDuration(entry.avgTimeToMergeMs),
    },
  ];
  return (
    <AnalyticsTable
      label="Pull requests by repository"
      rows={entries}
      columns={columns}
      rowKey={(entry) => entry.key}
      initialSort={{ columnId: "created", direction: "desc" }}
      limit={limit}
      emptyMessage="No pull requests found for this range."
    />
  );
}
