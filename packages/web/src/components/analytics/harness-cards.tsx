import {
  getCacheHitRatio,
  type AnalyticsBreakdownResponse,
} from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount, formatAnalyticsRatio, formatCompletionRate } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

interface HarnessCardsProps {
  entries?: AnalyticsBreakdownResponse["entries"];
  loading: boolean;
}

export function AnalyticsHarnessCards({ entries, loading }: HarnessCardsProps) {
  if (loading && !entries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-36 rounded bg-muted" />
        <div className="mt-2 h-4 w-64 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted" />
      </div>
    );
  }

  if (!entries?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Sessions by Harness</div>
        <p className="mt-1 text-sm text-muted-foreground">No harness data found for this range.</p>
      </div>
    );
  }

  return (
    <section aria-label="Sessions by Harness" className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Sessions by Harness</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <article key={entry.key} className="rounded-md border border-border-muted bg-card p-5">
            <h3 className="text-lg font-semibold text-foreground">
              {entry.displayName ?? entry.key}
            </h3>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Sessions</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {formatAnalyticsCount(entry.sessions)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cost</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {formatSessionCost(entry.cost)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Completion rate</dt>
                <dd className="mt-1 font-medium text-foreground">{formatCompletionRate(entry)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">PRs</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {formatAnalyticsCount(entry.prs)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cache hit ratio</dt>
                <dd className="mt-1 font-medium text-foreground">
                  {formatAnalyticsRatio(getCacheHitRatio(entry))}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
