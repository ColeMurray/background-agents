import type { AnalyticsPullRequestSourceEntry } from "@open-inspect/shared/types/analytics";
import { ANALYTICS_SOURCE_LABELS, formatAnalyticsCount } from "@/lib/analytics";
import { AnalyticsRankedBars } from "./analytics-ranked-bars";

/** Where the sessions behind the window's PRs came from, with how many merged. */
export function AnalyticsPullRequestSources({
  entries,
}: {
  entries: AnalyticsPullRequestSourceEntry[];
}) {
  return (
    <AnalyticsRankedBars
      label="Pull requests by source"
      rows={entries.map((entry) => ({
        key: entry.source,
        label: ANALYTICS_SOURCE_LABELS[entry.source],
        value: entry.created,
        display: formatAnalyticsCount(entry.created),
        secondary: `${formatAnalyticsCount(entry.merged)} merged`,
      }))}
      emptyMessage="No pull requests found for this range."
    />
  );
}
