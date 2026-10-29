import type { AnalyticsPullRequestFunnel } from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount, formatPullRequestAcceptanceRate } from "@/lib/analytics";
import { AnalyticsEmptyNote } from "./analytics-panel";

// The PR state colors used across the app (merged, open, draft, closed).
const OUTCOMES = [
  ["merged", "Merged", "bg-success"],
  ["open", "Open", "bg-accent"],
  ["draft", "Draft", "bg-muted-foreground"],
  ["closed", "Closed unmerged", "bg-destructive"],
] as const;

/** Where the PRs opened in the window stand now: one part-to-whole bar and labelled counts. */
export function AnalyticsPullRequestOutcomes({ funnel }: { funnel: AnalyticsPullRequestFunnel }) {
  if (!funnel.created) {
    return <AnalyticsEmptyNote>No pull requests found for this range.</AnalyticsEmptyNote>;
  }
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm">
          <span className="text-2xl font-semibold tracking-tight">
            {formatAnalyticsCount(funnel.created)}
          </span>{" "}
          <span className="text-muted-foreground">opened</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {formatPullRequestAcceptanceRate(funnel)} of resolved PRs merged
        </span>
      </div>
      <div aria-hidden="true" className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {OUTCOMES.map(([state, , color]) =>
          funnel[state] > 0 ? (
            <span key={state} className={`h-full ${color}`} style={{ flexGrow: funnel[state] }} />
          ) : null
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {OUTCOMES.map(([state, label, color]) => (
          <div key={state}>
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${color}`} />
              {label}
            </dt>
            <dd className="tabular-nums">{formatAnalyticsCount(funnel[state])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
