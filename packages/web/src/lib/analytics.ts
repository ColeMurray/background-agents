import type {
  AnalyticsBreakdownEntry,
  AnalyticsDays,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";

export const ANALYTICS_REFRESH_INTERVAL_MS = 30_000;
export const ANALYTICS_DAYS: AnalyticsDays[] = [7, 14, 30, 90];

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsDays, string> = {
  7: "7d",
  14: "14d",
  30: "30d",
  90: "90d",
};

export type AnalyticsUserSortKey =
  | "user"
  | "sessions"
  | "completionRate"
  | "prs"
  | "messageCount"
  | "cost"
  | "avgDuration"
  | "lastActive";

export type AnalyticsSortDirection = "asc" | "desc";

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const INTEGER_FORMATTER = new Intl.NumberFormat("en-US");

function parseAnalyticsDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAnalyticsCount(value: number): string {
  return INTEGER_FORMATTER.format(value);
}

export function formatAnalyticsDate(value: string): string {
  const parsed = parseAnalyticsDate(value);
  return parsed ? SHORT_DATE_FORMATTER.format(parsed) : value;
}

export function formatAnalyticsLongDate(value: string): string {
  const parsed = parseAnalyticsDate(value);
  return parsed ? LONG_DATE_FORMATTER.format(parsed) : value;
}

export function formatAnalyticsDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 && minutes < 5 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

export function getCompletionRate(entry: AnalyticsBreakdownEntry): number {
  const terminalSessions = entry.completed + entry.failed + entry.cancelled;
  return terminalSessions > 0 ? entry.completed / terminalSessions : 0;
}

export function formatCompletionRate(entry: AnalyticsBreakdownEntry): string {
  return `${Math.round(getCompletionRate(entry) * 100)}%`;
}

const UNKNOWN_SENTINEL = "__unknown__";

export function buildTimeseriesChartData(series: AnalyticsTimeseriesResponse["series"]): {
  data: Array<Record<string, number | string>>;
  groupKeys: string[];
  labelMap: Record<string, string>;
} {
  const totals = new Map<string, number>();

  for (const point of series) {
    for (const [groupKey, count] of Object.entries(point.groups)) {
      totals.set(groupKey, (totals.get(groupKey) ?? 0) + count);
    }
  }

  const groupKeys = Array.from(totals.entries())
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([groupKey]) => groupKey);

  const labelMap: Record<string, string> = {};
  for (const key of groupKeys) {
    if (key === UNKNOWN_SENTINEL) {
      labelMap[key] = "Unknown user";
    }
  }

  const data = series.map((point) => {
    const row: Record<string, number | string> = {
      date: point.date,
      label: formatAnalyticsDate(point.date),
    };

    for (const groupKey of groupKeys) {
      row[groupKey] = point.groups[groupKey] ?? 0;
    }

    return row;
  });

  return { data, groupKeys, labelMap };
}

export function sortAnalyticsUserEntries(
  entries: AnalyticsBreakdownEntry[],
  sortKey: AnalyticsUserSortKey,
  direction: AnalyticsSortDirection
): AnalyticsBreakdownEntry[] {
  const multiplier = direction === "asc" ? 1 : -1;

  return [...entries].sort((left, right) => {
    let comparison = 0;

    switch (sortKey) {
      case "user":
        comparison = (left.displayName ?? left.key).localeCompare(right.displayName ?? right.key);
        break;
      case "completionRate":
        comparison = getCompletionRate(left) - getCompletionRate(right);
        break;
      case "sessions":
        comparison = left.sessions - right.sessions;
        break;
      case "prs":
        comparison = left.prs - right.prs;
        break;
      case "messageCount":
        comparison = left.messageCount - right.messageCount;
        break;
      case "cost":
        comparison = left.cost - right.cost;
        break;
      case "avgDuration":
        comparison = left.avgDuration - right.avgDuration;
        break;
      case "lastActive":
        comparison = left.lastActive - right.lastActive;
        break;
    }

    if (comparison === 0) {
      return left.key.localeCompare(right.key);
    }

    return comparison * multiplier;
  });
}
