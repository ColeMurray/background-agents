import type { AnalyticsStatusBreakdown } from "@open-inspect/shared/types/analytics";
import {
  formatAnalyticsCount,
  formatAnalyticsRatio,
  getCompletionRate,
  getFinishedSessionCount,
} from "@/lib/analytics";
import { AnalyticsMeter } from "./analytics-kpis";

const STATUS_ROWS = [
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
  ["archived", "Archived"],
  ["active", "Running"],
  ["created", "Never started"],
] as const;

/** Completion rate as the headline, with every status as a labelled count. */
export function AnalyticsSessionStatusSummary({ status }: { status: AnalyticsStatusBreakdown }) {
  const finished = getFinishedSessionCount(status);
  const completion = finished > 0 ? getCompletionRate(status) : null;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight">
          {formatAnalyticsRatio(completion)}
        </span>
        <span className="text-sm text-muted-foreground">completion rate</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {formatAnalyticsCount(status.completed)} of {formatAnalyticsCount(finished)} finished
        sessions completed
      </p>
      {completion !== null ? <AnalyticsMeter ratio={completion} className="mt-2" /> : null}
      <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
        {STATUS_ROWS.map(([key, label]) => (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{formatAnalyticsCount(status[key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
