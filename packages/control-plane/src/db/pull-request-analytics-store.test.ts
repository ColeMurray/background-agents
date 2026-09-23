import { describe, expect, it } from "vitest";
import { PullRequestAnalyticsStore } from "./pull-request-analytics-store";
import type { SqlResult } from "./sql-database";

function result(results: unknown[]): SqlResult {
  return { results, meta: { changes: 0 } };
}

function store() {
  return new PullRequestAnalyticsStore({
    prepare: () => {
      throw new Error("not used");
    },
    batch: async () => {
      throw new Error("not used");
    },
  });
}

describe("PullRequestAnalyticsStore row decoding", () => {
  it("decodes valid persisted analytics rows", () => {
    expect(
      store().decode([
        result([{ created: 5, open: 2, draft: 1, merged: 1, closed: 1 }]),
        result([{ cost: 12.5 }]),
        result([{ merged: 2, avg_time_to_merge_ms: null }]),
        result([{ total: 3, avg_age_ms: 1000 }]),
        result([{ day_index: 1, count: 4 }]),
        result([{ day_index: 2, count: 2 }]),
        result([{ key: "acme/app", created: 5, merged: 1, closed: 1, avg_time_to_merge_ms: null }]),
        result([{ source: "automation", created: 3, merged: 1 }]),
      ])
    ).toEqual({
      funnel: { created: 5, open: 2, draft: 1, merged: 1, closed: 1 },
      prSessionCost: 12.5,
      mergedInWindow: 2,
      avgTimeToMergeMs: null,
      openInventory: { total: 3, avgAgeMs: 1000 },
      timeseries: [
        { date: "1970-01-02", created: 4, merged: 0 },
        { date: "1970-01-03", created: 0, merged: 2 },
      ],
      repos: [{ key: "acme/app", created: 5, merged: 1, closed: 1, avgTimeToMergeMs: null }],
      sources: [{ source: "automation", created: 3, merged: 1 }],
    });
  });

  it("rejects malformed persisted analytics rows", () => {
    expect(() =>
      store().decode([
        result([{ created: "5", open: 2, draft: 1, merged: 1, closed: 1 }]),
        result([{ cost: 12.5 }]),
        result([{ merged: 2, avg_time_to_merge_ms: null }]),
        result([{ total: 3, avg_age_ms: 1000 }]),
        result([]),
        result([]),
        result([]),
        result([]),
      ])
    ).toThrow("Invalid PR funnel row");
  });
});
