import type { SpawnSource } from "./statuses";

export const ANALYTICS_DAYS = [7, 14, 30, 90] as const;
export type AnalyticsDays = (typeof ANALYTICS_DAYS)[number];

export const ANALYTICS_BREAKDOWN_BY = ["user", "repo"] as const;
export type AnalyticsBreakdownBy = (typeof ANALYTICS_BREAKDOWN_BY)[number];

export interface AnalyticsStatusBreakdown {
  created: number;
  active: number;
  completed: number;
  failed: number;
  archived: number;
  cancelled: number;
}

export interface AnalyticsSummaryResponse {
  totalSessions: number;
  activeUsers: number;
  totalCost: number;
  avgCost: number;
  totalPrs: number;
  statusBreakdown: AnalyticsStatusBreakdown;
}

export interface AnalyticsTimeseriesPoint {
  date: string;
  groups: Record<string, number>;
}

export interface AnalyticsTimeseriesResponse {
  series: AnalyticsTimeseriesPoint[];
}

export interface AnalyticsBreakdownEntry {
  key: string;
  displayName?: string;
  sessions: number;
  completed: number;
  failed: number;
  cancelled: number;
  cost: number;
  prs: number;
  messageCount: number;
  avgDuration: number;
  lastActive: number;
}

export interface AnalyticsBreakdownResponse {
  entries: AnalyticsBreakdownEntry[];
}

// ─── Pull-request analytics ──────────────────────────────────────────────────
//
// PR-scoped by design (docs/pr-analytics-design.md §2): sessions serve many
// non-PR use-cases, so every metric here is conditioned on "given a PR exists"
// — numerators and denominators both come from session_pull_requests, and
// sessions/users/repos are join dimensions only. Unlike the session analytics,
// no spawn-source filter: automation-produced PRs are output too.

/** Outcome mix of the PRs created in the window (open PRs are still-open, not failures). */
export interface AnalyticsPullRequestFunnel {
  created: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
}

export interface AnalyticsPullRequestTimeseriesPoint {
  date: string;
  /** PRs created that day (bucketed by provider creation time). */
  created: number;
  /** PRs merged that day (bucketed by merged_at). */
  merged: number;
}

export interface AnalyticsPullRequestRepoEntry {
  /** owner/name of the repository the PR lives in. */
  key: string;
  created: number;
  merged: number;
  closed: number;
  /** Mean open→merge duration over this repo's cohort PRs; null when none merged. */
  avgTimeToMergeMs: number | null;
}

export interface AnalyticsPullRequestSourceEntry {
  /** The producing session's spawn_source. */
  source: SpawnSource;
  created: number;
  merged: number;
}

export interface AnalyticsPullRequestsResponse {
  funnel: AnalyticsPullRequestFunnel;
  /**
   * Σ total_cost of sessions that produced ≥1 cohort PR — the cost basis for
   * cost-per-merged-PR. Never platform-wide cost: non-PR sessions are out of
   * scope by the PR-analytics scoping rule.
   */
  prSessionCost: number;
  /** PRs whose merged_at falls in the window (regardless of creation cohort). */
  mergedInWindow: number;
  /** Mean open→merge duration of those merges; null when none. */
  avgTimeToMergeMs: number | null;
  /** Open PRs as of now (not windowed) — work-in-progress inventory. */
  openInventory: {
    total: number;
    avgAgeMs: number | null;
  };
  timeseries: AnalyticsPullRequestTimeseriesPoint[];
  repos: AnalyticsPullRequestRepoEntry[];
  sources: AnalyticsPullRequestSourceEntry[];
}
