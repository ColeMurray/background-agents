import type { AnalyticsDays, AnalyticsSummaryResponse } from "@open-inspect/shared";
import { formatSessionCost } from "@/lib/session-cost";
import { formatAnalyticsCount } from "@/lib/analytics";

interface SummaryCardsProps {
  days: AnalyticsDays;
  summary?: AnalyticsSummaryResponse;
  loading: boolean;
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="relative overflow-hidden rounded-md border border-border-muted bg-card p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)]" />
      <div className="text-xs uppercase tracking-[0.16em] text-secondary-foreground">{label}</div>
      <div className="mt-3 text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-2 text-sm text-muted-foreground">{hint}</div>
    </div>
  );
}

export function AnalyticsSummaryCards({ days, summary, loading }: SummaryCardsProps) {
  if (loading && !summary) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="rounded-md border border-border-muted bg-card p-4 animate-pulse"
          >
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="mt-4 h-7 w-20 rounded bg-muted" />
            <div className="mt-3 h-4 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (!summary) return null;

  const statusTiles = [
    ["completed", summary.statusBreakdown.completed, "bg-success"],
    ["active", summary.statusBreakdown.active, "bg-info"],
    ["created", summary.statusBreakdown.created, "bg-secondary-foreground"],
    ["failed", summary.statusBreakdown.failed, "bg-destructive"],
    ["cancelled", summary.statusBreakdown.cancelled, "bg-destructive/60"],
    ["archived", summary.statusBreakdown.archived, "bg-muted-foreground"],
  ] as const;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="Total Sessions"
          value={formatAnalyticsCount(summary.totalSessions)}
          hint={`Across the last ${days} days`}
        />
        <SummaryCard
          label="Active Users"
          value={formatAnalyticsCount(summary.activeUsers)}
          hint="Distinct SCM logins"
        />
        <SummaryCard
          label="Total Cost"
          value={formatSessionCost(summary.totalCost)}
          hint="Summed across sessions"
        />
        <SummaryCard
          label="Avg Cost / Session"
          value={formatSessionCost(summary.avgCost)}
          hint="Average per session"
        />
        <SummaryCard
          label="PRs Created"
          value={formatAnalyticsCount(summary.totalPrs)}
          hint="Platform-tracked PR artifacts"
        />
      </div>

      <div className="rounded-md border border-border-muted bg-card px-4 py-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-secondary-foreground">
              Status Mix
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Session states within the selected window.
            </div>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
          {statusTiles.map(([label, count, barClass]) => {
            const width =
              summary.totalSessions > 0
                ? Math.max((count / summary.totalSessions) * 100, count > 0 ? 8 : 0)
                : 0;

            return (
              <div
                key={label}
                className="rounded-md border border-border-muted bg-background px-3 py-3"
              >
                <div className="text-[11px] uppercase tracking-[0.14em] text-secondary-foreground">
                  {label}
                </div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {formatAnalyticsCount(count)}
                </div>
                <div className="mt-3 h-1.5 rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${barClass}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
