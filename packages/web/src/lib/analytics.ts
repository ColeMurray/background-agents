import {
  ANALYTICS_DAYS,
  ANALYTICS_SCOPES,
  DEFAULT_ANALYTICS_DAYS,
  DEFAULT_ANALYTICS_SCOPE,
  type AnalyticsBreakdownEntry,
  type AnalyticsDashboardResponse,
  type AnalyticsDays,
  type AnalyticsPullRequestFunnel,
  type AnalyticsScope,
  type AnalyticsSessionOriginEntry,
} from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";

export const ANALYTICS_REFRESH_INTERVAL_MS = 30_000;

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsDays, string> = {
  7: "7d",
  14: "14d",
  30: "30d",
  90: "90d",
};

export const ANALYTICS_SCOPE_LABELS: Record<AnalyticsScope, string> = {
  human: "Human",
  agent: "Agents",
  automation: "Automations",
  all: "All",
};

/** What each scope includes; pull request metrics ignore scope entirely. */
export const ANALYTICS_SCOPE_DESCRIPTIONS: Record<AnalyticsScope, string> = {
  human: "User/app and integration sessions (Slack, Linear and GitHub).",
  agent: "Sessions spawned by other sessions.",
  automation: "Sessions started by automations.",
  all: "Every session.",
};

/** Names the slice of sessions that scoped numbers describe. */
export const ANALYTICS_SCOPE_CAPTIONS: Record<AnalyticsScope, string> = {
  human: "Human sessions",
  agent: "Agent sub-sessions",
  automation: "Automation sessions",
  all: "All sessions",
};

export const ANALYTICS_SOURCE_LABELS: Record<SpawnSource, string> = {
  user: "User / app",
  "slack-bot": "Slack",
  "github-bot": "GitHub",
  "linear-bot": "Linear",
  agent: "Agent sub-sessions",
  automation: "Automations",
};

export const ANALYTICS_TABS = ["overview", "usage", "cost", "pull-requests", "people"] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export const ANALYTICS_TAB_LABELS: Record<AnalyticsTab, string> = {
  overview: "Overview",
  usage: "Usage",
  cost: "Cost",
  "pull-requests": "Pull requests",
  people: "People",
};

/** Sessions without a recorded user share this key in breakdowns and the timeseries. */
export const ANALYTICS_UNKNOWN_USER_KEY = "__unknown__";

export interface AnalyticsView {
  days: AnalyticsDays;
  scope: AnalyticsScope;
  tab: AnalyticsTab;
}

const DEFAULT_ANALYTICS_VIEW: AnalyticsView = {
  days: DEFAULT_ANALYTICS_DAYS,
  scope: DEFAULT_ANALYTICS_SCOPE,
  tab: "overview",
};

/** Reads the view from search params; anything missing or unknown falls back to the default. */
export function parseAnalyticsView(params: Pick<URLSearchParams, "get">): AnalyticsView {
  return {
    days:
      ANALYTICS_DAYS.find((days) => String(days) === params.get("days")) ??
      DEFAULT_ANALYTICS_VIEW.days,
    scope:
      ANALYTICS_SCOPES.find((scope) => scope === params.get("scope")) ??
      DEFAULT_ANALYTICS_VIEW.scope,
    tab: ANALYTICS_TABS.find((tab) => tab === params.get("tab")) ?? DEFAULT_ANALYTICS_VIEW.tab,
  };
}

/** Search params for a view change, leaving defaults out so the plain URL stays clean. */
export function buildAnalyticsSearch(
  current: URLSearchParams,
  change: Partial<AnalyticsView>
): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) continue;
    const isDefault = DEFAULT_ANALYTICS_VIEW[key as keyof AnalyticsView] === value;
    if (isDefault) next.delete(key);
    else next.set(key, String(value));
  }
  return next.toString();
}

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
const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const DAY_MS = 86_400_000;

function parseAnalyticsDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAnalyticsCount(value: number): string {
  return INTEGER_FORMATTER.format(value);
}

/** 1,284 / 12.9K / 35.8M: for token totals, where full precision is noise. */
export function formatAnalyticsCompactCount(value: number): string {
  return value < 10_000 ? INTEGER_FORMATTER.format(value) : COMPACT_FORMATTER.format(value);
}

/** Cents below $1,000 and whole dollars above; sub-cent precision is never meaningful here. */
export function formatAnalyticsCost(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "<$0.01";
  if (value >= 1000) return `$${INTEGER_FORMATTER.format(Math.round(value))}`;
  return `$${value.toFixed(2)}`;
}

export function formatAnalyticsRatio(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function formatAnalyticsDate(value: string): string {
  const parsed = parseAnalyticsDate(value);
  return parsed ? SHORT_DATE_FORMATTER.format(parsed) : value;
}

export function formatAnalyticsLongDate(value: string): string {
  const parsed = parseAnalyticsDate(value);
  return parsed ? LONG_DATE_FORMATTER.format(parsed) : value;
}

/** "Sep 3 – Oct 2": the first and last UTC day the window touches. */
export function formatAnalyticsWindow(
  window: Pick<AnalyticsDashboardResponse["window"], "startAt" | "endAt">
): string {
  const dates = getAnalyticsWindowDates(window);
  return `${formatAnalyticsDate(dates[0])} – ${formatAnalyticsDate(dates[dates.length - 1])}`;
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

type SessionOutcomeCounts = Pick<AnalyticsBreakdownEntry, "completed" | "failed" | "cancelled">;

/** Sessions that reached an outcome; drafts, running and archived sessions have not. */
export function getFinishedSessionCount(counts: SessionOutcomeCounts): number {
  return counts.completed + counts.failed + counts.cancelled;
}

export function getCompletionRate(counts: SessionOutcomeCounts): number {
  const finished = getFinishedSessionCount(counts);
  return finished > 0 ? counts.completed / finished : 0;
}

export function formatCompletionRate(counts: SessionOutcomeCounts): string {
  return `${Math.round(getCompletionRate(counts) * 100)}%`;
}

export function getAnalyticsDimensionLabels(
  entries: readonly Pick<AnalyticsBreakdownEntry, "key" | "displayName">[]
): Map<string, string> {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    const name = entry.displayName ?? entry.key;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const usedLabels = new Set<string>();
  return new Map<string, string>(
    entries.map((entry) => {
      const name = entry.displayName ?? entry.key;
      let label = (nameCounts.get(name) ?? 0) > 1 ? entry.key : name;
      let suffix = 2;
      while (usedLabels.has(label)) {
        label = `${name} (${entry.key}${suffix === 2 ? "" : `, ${suffix}`})`;
        suffix++;
      }
      usedLabels.add(label);
      return [entry.key, label];
    })
  );
}

/**
 * Merged ÷ resolved (merged + closed-without-merge). PR-scoped by design:
 * still-open PRs are not in the denominator (they haven't failed, they just
 * haven't resolved), and sessions never are. Null when nothing has resolved.
 */
export function getPullRequestAcceptanceRate(
  outcomes: Pick<AnalyticsPullRequestFunnel, "merged" | "closed">
): number | null {
  const resolved = outcomes.merged + outcomes.closed;
  return resolved > 0 ? outcomes.merged / resolved : null;
}

export function formatPullRequestAcceptanceRate(
  outcomes: Pick<AnalyticsPullRequestFunnel, "merged" | "closed">
): string {
  const rate = getPullRequestAcceptanceRate(outcomes);
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/**
 * Cost basis is the sessions that produced the cohort's PRs — never
 * platform-wide cost, which would charge non-PR work (Q&A, debugging,
 * research) against PR output. Null until something has merged.
 */
export function getCostPerMergedPullRequest(sessionCost: number, merged: number): number | null {
  return merged > 0 ? sessionCost / merged : null;
}

/** Duration formatter for day-scale spans (merge cycle time, open-PR age). */
export function formatAnalyticsLongDuration(durationMs: number): string {
  // Round to whole hours before splitting so the remainder can never render
  // as an invalid "2d 24h" — 2d 23h 45m carries into 3d.
  const totalHours = Math.round(durationMs / 3_600_000);
  if (totalHours >= 48) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  return formatAnalyticsDuration(durationMs);
}

/**
 * Every UTC day the window touches, oldest first. The API omits days without
 * activity, so series built on these dates plot quiet days as zero.
 */
export function getAnalyticsWindowDates(
  window: Pick<AnalyticsDashboardResponse["window"], "startAt" | "endAt">
): string[] {
  const dates: string[] = [];
  const lastDay = Math.floor((window.endAt - 1) / DAY_MS);
  for (let day = Math.floor(window.startAt / DAY_MS); day <= lastDay; day++) {
    dates.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
  }
  return dates;
}

export interface DailySessionCount {
  date: string;
  sessions: number;
}

export function getDailySessionCounts(dashboard: AnalyticsDashboardResponse): DailySessionCount[] {
  const totals = new Map<string, number>();
  for (const point of dashboard.timeseries.series) {
    const sessions = Object.values(point.groups).reduce((sum, count) => sum + count, 0);
    totals.set(point.date, (totals.get(point.date) ?? 0) + sessions);
  }
  return getAnalyticsWindowDates(dashboard.window).map((date) => ({
    date,
    sessions: totals.get(date) ?? 0,
  }));
}

/** The timeseries groups by display name, falling back to SCM login, then the unknown key. */
export function getUserTimeseriesGroup(
  entry: Pick<AnalyticsBreakdownEntry, "key" | "displayName">
): string {
  return entry.key === ANALYTICS_UNKNOWN_USER_KEY
    ? ANALYTICS_UNKNOWN_USER_KEY
    : (entry.displayName ?? entry.key);
}

/** Daily session counts for each timeseries group, aligned to the window's days. */
export function getDailySessionCountsByGroup(
  dashboard: AnalyticsDashboardResponse
): Map<string, number[]> {
  const dates = getAnalyticsWindowDates(dashboard.window);
  const positions = new Map(dates.map((date, index) => [date, index]));
  const byGroup = new Map<string, number[]>();
  for (const point of dashboard.timeseries.series) {
    const position = positions.get(point.date);
    if (position === undefined) continue;
    for (const [group, count] of Object.entries(point.groups)) {
      const counts = byGroup.get(group) ?? new Array<number>(dates.length).fill(0);
      counts[position] += count;
      byGroup.set(group, counts);
    }
  }
  return byGroup;
}

export interface DailyPullRequestCount {
  date: string;
  created: number;
  merged: number;
}

export function getDailyPullRequestCounts(
  dashboard: AnalyticsDashboardResponse
): DailyPullRequestCount[] {
  const byDate = new Map(dashboard.pullRequests.timeseries.map((point) => [point.date, point]));
  return getAnalyticsWindowDates(dashboard.window).map((date) => ({
    date,
    created: byDate.get(date)?.created ?? 0,
    merged: byDate.get(date)?.merged ?? 0,
  }));
}

export interface AnalyticsSourceTotal {
  source: SpawnSource;
  sessions: number;
  users: Array<{ key: string; name: string; sessions: number }>;
}

/** Sessions per source, largest first, each with its attributed users, largest first. */
export function getSessionsBySource(
  entries: readonly AnalyticsSessionOriginEntry[]
): AnalyticsSourceTotal[] {
  const sources = new Map<SpawnSource, AnalyticsSourceTotal>();
  for (const entry of entries) {
    const total = sources.get(entry.source) ?? { source: entry.source, sessions: 0, users: [] };
    total.sessions += entry.sessions;
    total.users.push({ key: entry.userKey, name: entry.displayName, sessions: entry.sessions });
    sources.set(entry.source, total);
  }
  return [...sources.values()]
    .map((total) => ({
      ...total,
      users: total.users.sort(
        (a, b) =>
          b.sessions - a.sessions || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
      ),
    }))
    .sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source));
}

/** Share of sessions billed through a connected subscription; those report $0 cost. */
export function getSubscriptionShare(
  providerEntries: readonly AnalyticsBreakdownEntry[]
): number | null {
  const sessions = providerEntries.reduce((sum, entry) => sum + entry.sessions, 0);
  const subscribed = providerEntries.reduce(
    (sum, entry) => sum + (entry.subscriptionSessions ?? 0),
    0
  );
  return sessions > 0 ? subscribed / sessions : null;
}

/**
 * The owner every repository key shares, so rows can show just the name. Owners
 * can be nested namespaces, so the name is whatever follows the last slash.
 */
export function getCommonRepositoryOwner(keys: readonly string[]): string | null {
  const owners = new Set(
    keys.filter((key) => key.includes("/")).map((key) => key.slice(0, key.lastIndexOf("/")))
  );
  return owners.size === 1 ? [...owners][0] : null;
}

export function formatRepositoryName(key: string, commonOwner: string | null): string {
  return commonOwner && key.startsWith(`${commonOwner}/`) ? key.slice(commonOwner.length + 1) : key;
}
