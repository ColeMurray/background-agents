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
        result([{ key: "openai/gpt-5", created: 3, merged: 1, session_cost: 8 }]),
        result([{ key: "claude", created: 2, merged: 1, session_cost: 4 }]),
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
      models: [
        { key: "openai/gpt-5", displayName: "openai/gpt-5", created: 3, merged: 1, sessionCost: 8 },
      ],
      harnesses: [
        { key: "claude", displayName: "Claude Agent", created: 2, merged: 1, sessionCost: 4 },
      ],
    });
  });

  it("merges bare and prefixed model rows under the canonical key and re-sorts by cost", () => {
    const results = Array.from({ length: 10 }, () => result([]));
    results[8] = result([
      { key: "openai/gpt-5", created: 1, merged: 1, session_cost: 4 },
      { key: "anthropic/claude-haiku-4-5", created: 2, merged: 1, session_cost: 3 },
      { key: "claude-haiku-4-5", created: 1, merged: 0, session_cost: 2 },
    ]);

    expect(store().decode(results).models).toEqual([
      {
        key: "anthropic/claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
        created: 3,
        merged: 1,
        sessionCost: 5,
      },
      { key: "openai/gpt-5", displayName: "openai/gpt-5", created: 1, merged: 1, sessionCost: 4 },
    ]);
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

  it("validates model and harness results at their appended batch positions", () => {
    const results = Array.from({ length: 10 }, () => result([]));
    results[8] = result([{ key: "openai/gpt-5", created: 2, merged: 1, session_cost: "3" }]);
    expect(() => store().decode(results)).toThrow("Invalid PR model row");
    results[8] = result([]);
    results[9] = result([{ key: "claude", created: 2, merged: 1, session_cost: "3" }]);
    expect(() => store().decode(results)).toThrow("Invalid PR harness row");
  });
});
