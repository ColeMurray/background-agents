import { describe, expect, it } from "vitest";
import {
  buildAnalyticsSearch,
  formatAnalyticsCompactCount,
  formatAnalyticsCost,
  formatAnalyticsDate,
  formatAnalyticsDuration,
  formatAnalyticsLongDate,
  formatAnalyticsLongDuration,
  formatAnalyticsRatio,
  formatCompletionRate,
  getCompletionRate,
  formatPullRequestAcceptanceRate,
  getAnalyticsDimensionLabels,
  getCostPerMergedPullRequest,
  formatAnalyticsWindow,
  formatRepositoryName,
  getAnalyticsWindowDates,
  getCommonRepositoryOwner,
  getDailyPullRequestCounts,
  getDailySessionCounts,
  getDailySessionCountsByUser,
  getPullRequestAcceptanceRate,
  getSessionsBySource,
  getSubscriptionShare,
  parseAnalyticsView,
} from "./analytics";
import { analyticsDashboard, breakdownEntry } from "./analytics.test-fixture";

describe("analytics utilities", () => {
  it("keeps final dimension labels unique when a fallback key matches another display name", () => {
    const labels = getAnalyticsDimensionLabels([
      { key: "a", displayName: "Daily" },
      { key: "b", displayName: "Daily" },
      { key: "d", displayName: "a (c)" },
      { key: "c", displayName: "a" },
    ]);

    expect(labels.get("a")).toBe("a");
    expect(labels.get("b")).toBe("b");
    expect(labels.get("d")).toBe("a (c)");
    expect(labels.get("c")).toContain("c");
    expect(new Set(labels.values()).size).toBe(4);
  });

  it("formats a nullable ratio as a rounded percentage", () => {
    expect(formatAnalyticsRatio(null)).toBe("—");
    expect(formatAnalyticsRatio(0)).toBe("0%");
    expect(formatAnalyticsRatio(0.416)).toBe("42%");
  });
  it("has no completion rate until a session finishes", () => {
    const nothingFinished = { completed: 0, failed: 0, cancelled: 0 };
    expect(getCompletionRate(nothingFinished)).toBeNull();
    expect(formatCompletionRate(nothingFinished)).toBe("—");
    expect(getCompletionRate({ completed: 0, failed: 2, cancelled: 0 })).toBe(0);
  });

  it("formats completion rate from terminal sessions only", () => {
    expect(formatCompletionRate({ completed: 3, failed: 1, cancelled: 2 })).toBe("50%");
  });

  it("formats durations compactly", () => {
    expect(formatAnalyticsDuration(4_000)).toBe("4s");
    expect(formatAnalyticsDuration(125_000)).toBe("2m 5s");
    expect(formatAnalyticsDuration(3_900_000)).toBe("1h 5m");
  });

  it("falls back to the raw value for invalid analytics dates", () => {
    expect(formatAnalyticsDate("not-a-date")).toBe("not-a-date");
    expect(formatAnalyticsLongDate("not-a-date")).toBe("not-a-date");
  });

  it("computes acceptance rate over resolved PRs only", () => {
    // Open PRs are not failures — only merged + closed count as resolved.
    expect(getPullRequestAcceptanceRate({ merged: 3, closed: 1 })).toBe(0.75);
    expect(formatPullRequestAcceptanceRate({ merged: 3, closed: 1 })).toBe("75%");
    expect(getPullRequestAcceptanceRate({ merged: 0, closed: 0 })).toBeNull();
    expect(formatPullRequestAcceptanceRate({ merged: 0, closed: 0 })).toBe("—");
  });

  it("computes cost per merged PR from the PR-session cost basis", () => {
    expect(getCostPerMergedPullRequest(3, 2)).toBe(1.5);
    expect(getCostPerMergedPullRequest(3, 0)).toBeNull();
  });

  it("formats day-scale durations with days and hours", () => {
    const day = 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    expect(formatAnalyticsLongDuration(3 * day + 4 * hour)).toBe("3d 4h");
    expect(formatAnalyticsLongDuration(2 * day)).toBe("2d");
    // Rounded hours carry into the day count — never an invalid "2d 24h".
    expect(formatAnalyticsLongDuration(2 * day + 23 * hour + 45 * 60 * 1000)).toBe("3d");
    // Under two days it falls back to the compact formatter.
    expect(formatAnalyticsLongDuration(90 * 60 * 1000)).toBe("1h 30m");
  });

  it("reads the view from search params and falls back to defaults", () => {
    expect(parseAnalyticsView(new URLSearchParams())).toEqual({
      days: 30,
      scope: "human",
      tab: "overview",
    });
    expect(
      parseAnalyticsView(new URLSearchParams("days=7&scope=automation&tab=pull-requests"))
    ).toEqual({ days: 7, scope: "automation", tab: "pull-requests" });
    expect(parseAnalyticsView(new URLSearchParams("days=8&scope=robots&tab=nope"))).toEqual({
      days: 30,
      scope: "human",
      tab: "overview",
    });
  });

  it("writes view changes into the search params and leaves defaults out", () => {
    const current = new URLSearchParams("days=7&other=kept");
    expect(buildAnalyticsSearch(current, { tab: "cost" })).toBe("days=7&other=kept&tab=cost");
    expect(buildAnalyticsSearch(current, { days: 30 })).toBe("other=kept");
    expect(buildAnalyticsSearch(new URLSearchParams("tab=cost"), { tab: "overview" })).toBe("");
    expect(current.toString()).toBe("days=7&other=kept");
  });

  it("lists every UTC day a window touches, including partial first and last days", () => {
    const dates = getAnalyticsWindowDates({
      startAt: Date.UTC(2026, 8, 17, 12),
      endAt: Date.UTC(2026, 8, 24, 12),
    });
    expect(dates).toHaveLength(8);
    expect(dates[0]).toBe("2026-09-17");
    expect(dates.at(-1)).toBe("2026-09-24");
    expect(
      formatAnalyticsWindow({
        startAt: Date.UTC(2026, 8, 17, 12),
        endAt: Date.UTC(2026, 8, 24, 12),
      })
    ).toBe("Sep 17 – Sep 24");
  });

  it("totals sessions per day and plots days the API omits as zero", () => {
    const daily = getDailySessionCounts(analyticsDashboard());
    expect(daily).toHaveLength(8);
    expect(daily.find((day) => day.date === "2026-09-18")?.sessions).toBe(3);
    expect(daily.find((day) => day.date === "2026-09-20")?.sessions).toBe(0);
    expect(daily.find((day) => day.date === "2026-09-22")?.sessions).toBe(4);
  });

  it("aligns each user's daily sessions to the window, keyed like the user breakdown", () => {
    const byUser = getDailySessionCountsByUser(analyticsDashboard());
    expect(byUser.get("user-zoe")).toEqual([0, 2, 0, 0, 0, 3, 0, 0]);
    expect(byUser.get("__unknown__")).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
    expect(byUser.get("Zoe")).toBeUndefined();
  });

  it("zero-fills pull requests per day across the window", () => {
    const daily = getDailyPullRequestCounts(analyticsDashboard());
    expect(daily).toHaveLength(8);
    expect(daily.find((day) => day.date === "2026-09-23")).toEqual({
      date: "2026-09-23",
      created: 6,
      merged: 3,
    });
    expect(daily.find((day) => day.date === "2026-09-24")).toEqual({
      date: "2026-09-24",
      created: 0,
      merged: 0,
    });
  });

  it("ranks sources by sessions and their users by sessions", () => {
    const sources = getSessionsBySource(analyticsDashboard().sessionOrigins);
    expect(sources.map((source) => [source.source, source.sessions])).toEqual([
      ["slack-bot", 8],
      ["github-bot", 1],
      ["user", 1],
    ]);
    expect(sources[0].users.map((user) => user.name)).toEqual(["Zoe", "Anna"]);
  });

  it("computes the subscription-billed share of sessions", () => {
    expect(getSubscriptionShare(analyticsDashboard().breakdowns.provider.entries)).toBe(4 / 12);
    expect(getSubscriptionShare([])).toBeNull();
    expect(getSubscriptionShare([breakdownEntry("x", { subscriptionSessions: undefined })])).toBe(
      0
    );
  });

  it("formats costs to the cent below $1,000 and never with sub-cent digits", () => {
    expect(formatAnalyticsCost(null)).toBe("—");
    expect(formatAnalyticsCost(0)).toBe("$0");
    expect(formatAnalyticsCost(0.004)).toBe("<$0.01");
    expect(formatAnalyticsCost(0.8565)).toBe("$0.86");
    expect(formatAnalyticsCost(537.05)).toBe("$537.05");
    expect(formatAnalyticsCost(1333.82)).toBe("$1,334");
  });

  it("compacts large counts", () => {
    expect(formatAnalyticsCompactCount(9_999)).toBe("9,999");
    expect(formatAnalyticsCompactCount(35_791_218)).toBe("35.8M");
  });

  it("shows repositories without an owner every row shares, splitting on the last slash", () => {
    expect(getCommonRepositoryOwner(["acme/web", "acme/api", "No repository"])).toBe("acme");
    expect(getCommonRepositoryOwner(["group/sub/web", "group/sub/api"])).toBe("group/sub");
    expect(getCommonRepositoryOwner(["acme/web", "other/api"])).toBeNull();
    expect(formatRepositoryName("group/sub/web", "group/sub")).toBe("web");
    expect(formatRepositoryName("No repository", "acme")).toBe("No repository");
    expect(formatRepositoryName("acme/web", null)).toBe("acme/web");
  });
});
