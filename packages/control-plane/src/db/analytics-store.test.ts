import { describe, expect, it } from "vitest";
import { AnalyticsStore } from "./analytics-store";
import type { SqlResult } from "./sql-database";

function result(results: unknown[]): SqlResult {
  return { results, meta: { changes: 0 } };
}

describe("AnalyticsStore row decoding", () => {
  const store = new AnalyticsStore({
    prepare: () => {
      throw new Error("not used");
    },
    batch: async () => {
      throw new Error("not used");
    },
  });

  it("decodes a valid summary row", () => {
    expect(
      store.decodeSummary(
        result([
          {
            total_sessions: 2,
            active_users: 1,
            total_cost: 4,
            total_prs: 3,
            created_count: 1,
            active_count: 0,
            completed_count: 1,
            failed_count: 0,
            archived_count: 0,
            cancelled_count: 0,
          },
        ])
      )
    ).toEqual({
      totalSessions: 2,
      activeUsers: 1,
      totalCost: 4,
      avgCost: 2,
      totalPrs: 3,
      statusBreakdown: {
        created: 1,
        active: 0,
        completed: 1,
        failed: 0,
        archived: 0,
        cancelled: 0,
      },
    });
  });

  it("rejects a malformed summary row", () => {
    expect(() =>
      store.decodeSummary(
        result([
          {
            total_sessions: "2",
            active_users: 1,
            total_cost: 4,
            total_prs: 3,
            created_count: 1,
            active_count: 0,
            completed_count: 1,
            failed_count: 0,
            archived_count: 0,
            cancelled_count: 0,
          },
        ])
      )
    ).toThrow("Invalid analytics summary row");
  });

  it("decodes valid timeseries rows", () => {
    expect(
      store.decodeTimeseries(
        result([
          { day_index: 1, group_key: "Ada", count: 2 },
          { day_index: 1, group_key: "Grace", count: 3 },
          { day_index: 2, group_key: "Ada", count: 4 },
        ])
      )
    ).toEqual({
      series: [
        { date: "1970-01-02", groups: { Ada: 2, Grace: 3 } },
        { date: "1970-01-03", groups: { Ada: 4 } },
      ],
    });
  });

  it("rejects a partial timeseries row", () => {
    expect(() => store.decodeTimeseries(result([{ day_index: 1, count: 2 }]))).toThrow(
      "Invalid analytics timeseries row"
    );
  });

  it("decodes nullable breakdown fields", () => {
    expect(
      store.decodeBreakdown(
        result([
          {
            key: null,
            display_name: null,
            sessions: 2,
            completed: 1,
            failed: 0,
            cancelled: 1,
            cost: 5,
            prs: 3,
            message_count: 8,
            avg_duration: 100,
            last_active: 200,
          },
        ])
      )
    ).toEqual({
      entries: [
        {
          key: "No repository",
          sessions: 2,
          completed: 1,
          failed: 0,
          cancelled: 1,
          cost: 5,
          prs: 3,
          messageCount: 8,
          avgDuration: 100,
          lastActive: 200,
        },
      ],
    });
  });

  it("rejects a partial breakdown row", () => {
    expect(() =>
      store.decodeBreakdown(
        result([
          {
            key: "repo/name",
            sessions: 2,
            completed: 1,
            failed: 0,
            cancelled: 1,
          },
        ])
      )
    ).toThrow("Invalid analytics breakdown row");
  });
});
