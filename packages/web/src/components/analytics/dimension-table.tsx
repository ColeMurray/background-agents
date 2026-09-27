import {
  getCacheHitRatio,
  type AnalyticsBreakdownResponse,
} from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount, formatAnalyticsRatio, formatCompletionRate } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

type DimensionColumn = "subscriptionSessions" | "cost" | "cacheHitRatio" | "completionRate" | "prs";

interface DimensionTableProps {
  title: string;
  description: string;
  keyLabel: string;
  entries?: AnalyticsBreakdownResponse["entries"];
  loading: boolean;
  emptyMessage: string;
  columns: readonly DimensionColumn[];
}

const columnLabels: Record<DimensionColumn, string> = {
  subscriptionSessions: "Subscription sessions",
  cost: "Cost",
  cacheHitRatio: "Cache hit ratio",
  completionRate: "Completion rate",
  prs: "PRs",
};

export function AnalyticsDimensionTable({
  title,
  description,
  keyLabel,
  entries,
  loading,
  emptyMessage,
  columns,
}: DimensionTableProps) {
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
        <div className="text-lg font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-muted bg-card">
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-muted text-left text-secondary-foreground">
              <th scope="col" className="px-5 py-3">
                {keyLabel}
              </th>
              <th scope="col" className="px-5 py-3 text-right">
                Sessions
              </th>
              {columns.map((column) => (
                <th key={column} scope="col" className="px-5 py-3 text-right">
                  {columnLabels[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const values: Record<DimensionColumn, string> = {
                subscriptionSessions:
                  entry.subscriptionSessions === undefined
                    ? "—"
                    : formatAnalyticsCount(entry.subscriptionSessions),
                cost: formatSessionCost(entry.cost),
                cacheHitRatio: formatAnalyticsRatio(getCacheHitRatio(entry)),
                completionRate: formatCompletionRate(entry),
                prs: formatAnalyticsCount(entry.prs),
              };

              return (
                <tr
                  key={entry.key}
                  className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
                >
                  <td className="px-5 py-4 font-medium text-foreground">
                    {entry.displayName ?? entry.key}
                  </td>
                  <td className="px-5 py-4 text-right text-foreground">
                    {formatAnalyticsCount(entry.sessions)}
                  </td>
                  {columns.map((column) => (
                    <td key={column} className="px-5 py-4 text-right text-foreground">
                      {values[column]}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {columns.includes("subscriptionSessions") ? (
        <div className="border-t border-border-muted px-5 py-3 text-xs text-muted-foreground">
          Sessions billed to a subscription report $0.
        </div>
      ) : null}
    </div>
  );
}
