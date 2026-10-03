"use client";

import { useState } from "react";
import type {
  AnalyticsPullRequestDimensionEntry,
  AnalyticsPullRequestsResponse,
} from "@open-inspect/shared/types/analytics";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  formatAnalyticsCost,
  formatAnalyticsCount,
  getAnalyticsDimensionLabels,
  getCostPerMergedPullRequest,
} from "@/lib/analytics";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

type PullRequestCostDimension = "models" | "harnesses";

const DIMENSION_OPTIONS = [
  { value: "models", label: "Models" },
  { value: "harnesses", label: "Harnesses" },
] as const;

/** Cost per merged PR by the model or harness of the sessions that produced the PRs. */
export function AnalyticsPullRequestCostTable({
  pullRequests,
}: {
  pullRequests: AnalyticsPullRequestsResponse;
}) {
  const [dimension, setDimension] = useState<PullRequestCostDimension>("models");
  const entries = pullRequests[dimension];
  const labels = getAnalyticsDimensionLabels(entries);
  const costPerMerged = (entry: AnalyticsPullRequestDimensionEntry) =>
    getCostPerMergedPullRequest(entry.sessionCost, entry.merged);
  const columns: AnalyticsTableColumn<AnalyticsPullRequestDimensionEntry>[] = [
    {
      id: "key",
      header: dimension === "models" ? "Model" : "Harness",
      sortValue: (entry) => labels.get(entry.key) ?? entry.key,
      cell: (entry) => <span className="font-medium">{labels.get(entry.key) ?? entry.key}</span>,
    },
    {
      id: "created",
      header: "Opened",
      align: "right",
      sortValue: (entry) => entry.created,
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
      id: "costPerMerged",
      header: "Cost per merged PR",
      align: "right",
      sortValue: costPerMerged,
      barValue: (entry) => costPerMerged(entry) ?? 0,
      cell: (entry) => formatAnalyticsCost(costPerMerged(entry)),
    },
  ];
  return (
    <div className="space-y-3">
      <SegmentedControl
        label="Cost per merged PR by"
        value={dimension}
        options={DIMENSION_OPTIONS}
        onValueChange={setDimension}
      />
      <AnalyticsTable
        key={dimension}
        label={
          dimension === "models" ? "Cost per merged PR by model" : "Cost per merged PR by harness"
        }
        rows={entries}
        columns={columns}
        rowKey={(entry) => entry.key}
        emptyMessage="No pull request cost data found for this range."
      />
    </div>
  );
}
