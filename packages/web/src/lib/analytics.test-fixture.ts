import type {
  AnalyticsBreakdownEntry,
  AnalyticsDashboardResponse,
  SessionRun,
} from "@open-inspect/shared/types/analytics";

const DAY_MS = 86_400_000;
/** Thu 2026-09-24 12:00 UTC, so a 7-day window touches Sep 17 through Sep 24. */
export const FIXTURE_NOW = Date.UTC(2026, 8, 24, 12);

const zeroTokens = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function breakdownEntry(
  key: string,
  overrides: Partial<AnalyticsBreakdownEntry> = {}
): AnalyticsBreakdownEntry {
  return {
    key,
    ...zeroTokens,
    sessions: 4,
    completed: 3,
    failed: 1,
    cancelled: 0,
    cost: 2,
    prs: 1,
    messageCount: 12,
    avgDuration: 120_000,
    lastActive: FIXTURE_NOW - DAY_MS,
    ...overrides,
  };
}

export function sessionRun(rootSessionId: string, overrides: Partial<SessionRun> = {}): SessionRun {
  return {
    rootSessionId,
    title: "Fix a bug",
    sessionCount: 3,
    maxSpawnDepth: 1,
    totalCost: 2.5,
    totalPrs: 1,
    ...zeroTokens,
    inputTokens: 1200,
    outputTokens: 345,
    createdAt: FIXTURE_NOW - 2 * 3_600_000,
    updatedAt: FIXTURE_NOW - 3_600_000,
    userId: "user-zoe",
    scmLogin: null,
    spawnSource: "user",
    automationId: null,
    repoOwner: "acme",
    repoName: "web",
    ...overrides,
  };
}

/** A small, internally consistent dashboard snapshot; override any part per test. */
export function analyticsDashboard(
  overrides: Partial<AnalyticsDashboardResponse> = {}
): AnalyticsDashboardResponse {
  return {
    generatedAt: FIXTURE_NOW,
    window: { days: 7, scope: "human", startAt: FIXTURE_NOW - 7 * DAY_MS, endAt: FIXTURE_NOW },
    summary: {
      ...zeroTokens,
      inputTokens: 12_345,
      outputTokens: 6_789,
      reasoningTokens: 321,
      cacheReadTokens: 5_000,
      cacheHitRatio: 5_000 / 17_345,
      totalSessions: 12,
      activeUsers: 3,
      totalCost: 12.5,
      privateSessionsCostUsd: null,
      avgCost: 12.5 / 12,
      totalPrs: 99,
      statusBreakdown: {
        created: 1,
        active: 1,
        completed: 7,
        failed: 2,
        archived: 0,
        cancelled: 1,
      },
    },
    timeseries: {
      // The API omits quiet days: nothing on Sep 19–21.
      series: [
        { date: "2026-09-18", groups: { Zoe: 2, Anna: 1 } },
        { date: "2026-09-22", groups: { Zoe: 3, __unknown__: 1 } },
        { date: "2026-09-24", groups: { Anna: 5 } },
      ],
    },
    sessionOrigins: [
      { source: "slack-bot", userKey: "user-zoe", displayName: "Zoe", sessions: 6 },
      { source: "slack-bot", userKey: "user-anna", displayName: "Anna", sessions: 2 },
      { source: "github-bot", userKey: "user-zoe", displayName: "Zoe", sessions: 1 },
      { source: "user", userKey: "__unknown__", displayName: "Unknown user", sessions: 1 },
    ],
    breakdowns: {
      repository: {
        entries: [
          breakdownEntry("acme/web", { sessions: 8, cost: 8.25 }),
          breakdownEntry("acme/api", { sessions: 3, cost: 3.75 }),
          breakdownEntry("No repository", { sessions: 1, cost: 0.5 }),
        ],
      },
      user: {
        entries: [
          breakdownEntry("user-zoe", { displayName: "Zoe", sessions: 5, cost: 6 }),
          breakdownEntry("user-anna", { displayName: "Anna", sessions: 6, cost: 4 }),
          breakdownEntry("__unknown__", { displayName: "Unknown user", sessions: 1, cost: 0.5 }),
        ],
      },
      model: {
        entries: [
          breakdownEntry("anthropic/claude-sonnet-5", { displayName: "Claude Sonnet 5", cost: 2 }),
          breakdownEntry("anthropic/claude-opus-4-8", { displayName: "Claude Opus 4.8", cost: 9 }),
        ],
      },
      harness: { entries: [breakdownEntry("opencode", { displayName: "OpenCode" })] },
      provider: {
        entries: [
          breakdownEntry("anthropic", {
            displayName: "Anthropic",
            sessions: 10,
            subscriptionSessions: 4,
          }),
          breakdownEntry("openai", { displayName: "OpenAI", sessions: 2, subscriptionSessions: 0 }),
        ],
      },
      automation: { entries: [] },
    },
    pullRequests: {
      funnel: { created: 10, open: 2, draft: 1, merged: 6, closed: 1 },
      prSessionCost: 9,
      mergedInWindow: 5,
      avgTimeToMergeMs: 30 * 3_600_000,
      openInventory: { total: 3, avgAgeMs: 50 * 3_600_000 },
      timeseries: [
        { date: "2026-09-18", created: 4, merged: 2 },
        { date: "2026-09-23", created: 6, merged: 3 },
      ],
      repos: [{ key: "acme/web", created: 10, merged: 6, closed: 1, avgTimeToMergeMs: 3_600_000 }],
      sources: [{ source: "user", created: 10, merged: 6 }],
      models: [
        {
          key: "anthropic/claude-opus-4-8",
          displayName: "Claude Opus 4.8",
          created: 8,
          merged: 6,
          sessionCost: 9,
        },
      ],
      harnesses: [
        { key: "opencode", displayName: "OpenCode", created: 10, merged: 6, sessionCost: 9 },
      ],
    },
    runs: [sessionRun("root-1")],
    ...overrides,
  };
}
