import { describe, expect, it } from "vitest";
import {
  buildTimeseriesChartData,
  formatAnalyticsDate,
  formatAnalyticsDuration,
  formatAnalyticsLongDate,
  formatCompletionRate,
  sortAnalyticsUserEntries,
} from "./analytics";

describe("analytics utilities", () => {
  it("builds chart data with zero-filled group values", () => {
    const result = buildTimeseriesChartData([
      { date: "2026-04-10", groups: { alice: 2, bob: 1 } },
      { date: "2026-04-11", groups: { alice: 1, charlie: 3 } },
    ]);

    expect(result.groupKeys).toEqual(["alice", "charlie", "bob"]);
    expect(result.labelMap).toEqual({});
    expect(result.data).toEqual([
      {
        date: "2026-04-10",
        label: "Apr 10",
        alice: 2,
        charlie: 0,
        bob: 1,
      },
      {
        date: "2026-04-11",
        label: "Apr 11",
        alice: 1,
        charlie: 3,
        bob: 0,
      },
    ]);
  });

  it("maps __unknown__ sentinel to 'Unknown user' in labelMap", () => {
    const result = buildTimeseriesChartData([
      { date: "2026-04-10", groups: { alice: 2, __unknown__: 1 } },
    ]);

    expect(result.groupKeys).toEqual(["alice", "__unknown__"]);
    expect(result.labelMap).toEqual({ __unknown__: "Unknown user" });
  });

  it("formats completion rate from terminal sessions only", () => {
    expect(
      formatCompletionRate({
        key: "alice",
        sessions: 7,
        completed: 3,
        failed: 1,
        cancelled: 2,
        cost: 1.5,
        prs: 1,
        messageCount: 10,
        avgDuration: 15_000,
        lastActive: 100,
      })
    ).toBe("50%");
  });

  it("sorts user entries by displayName when present", () => {
    const result = sortAnalyticsUserEntries(
      [
        {
          key: "user-id-1",
          displayName: "Zoe",
          sessions: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 1,
        },
        {
          key: "user-id-2",
          displayName: "Alice",
          sessions: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 2,
        },
      ],
      "user",
      "asc"
    );

    expect(result.map((entry) => entry.displayName)).toEqual(["Alice", "Zoe"]);
  });

  it("sorts user entries by key when displayName is missing", () => {
    const result = sortAnalyticsUserEntries(
      [
        {
          key: "user-id-1",
          displayName: "Zoe",
          sessions: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 1,
        },
        {
          key: "bob-login",
          sessions: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 2,
        },
      ],
      "user",
      "asc"
    );

    // "bob-login" (key fallback) sorts before "Zoe" (displayName)
    expect(result.map((entry) => entry.displayName ?? entry.key)).toEqual(["bob-login", "Zoe"]);
  });

  it("sorts user entries by completion rate descending", () => {
    const result = sortAnalyticsUserEntries(
      [
        {
          key: "alice",
          sessions: 4,
          completed: 3,
          failed: 1,
          cancelled: 0,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 1,
        },
        {
          key: "bob",
          sessions: 3,
          completed: 1,
          failed: 1,
          cancelled: 1,
          cost: 0,
          prs: 0,
          messageCount: 0,
          avgDuration: 0,
          lastActive: 2,
        },
      ],
      "completionRate",
      "desc"
    );

    expect(result.map((entry) => entry.key)).toEqual(["alice", "bob"]);
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
});
