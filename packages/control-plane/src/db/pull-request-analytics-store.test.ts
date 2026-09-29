import { describe, expect, it, vi } from "vitest";
import { PullRequestAnalyticsStore } from "./pull-request-analytics-store";
import type { SqlResult } from "./sql-database";

function result(results: unknown[]): SqlResult {
  return { results, meta: { changes: 0 } };
}

function store() {
  return new PullRequestAnalyticsStore(
    {
      prepare: () => {
        throw new Error("not used");
      },
      batch: async () => {
        throw new Error("not used");
      },
    },
    { kind: "internal", reason: "decode persisted rows" },
    "on"
  );
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

it("keeps missing-session PRs in cohort metrics but not in session dimensions", () => {
  const queries: string[] = [];
  const bindings: unknown[][] = [];
  const statement = {
    bind: (...values: unknown[]) => {
      bindings.push(values);
      return statement;
    },
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };
  const db = {
    prepare: (sql: string) => {
      queries.push(sql);
      return statement;
    },
    batch: async () => [],
  };
  const member = {
    kind: "user" as const,
    userId: "member",
    roleKey: "member" as const,
    permissions: ["analytics.read"] as const,
    suspended: false,
    memberships: new Map(),
  };
  new PullRequestAnalyticsStore(db, member, "on").prepare({ startAt: 10, endAt: 20, now: 30 });
  expect(queries).toHaveLength(10);
  expect(queries[0]).toContain("LEFT JOIN sessions s ON s.id = p.session_id");
  expect(queries[0]).toContain("s.id IS NULL OR");
  expect(queries[1]).toContain("LEFT JOIN sessions s ON s.id = cohort.session_id");
  expect(queries[1]).toContain("s.id IS NULL OR");
  expect(queries[7]).toContain("s.spawn_source IS NOT NULL");
  expect(queries[8]).toContain("LEFT JOIN sessions x ON x.id = cohort.session_id");
  expect(queries[8]).toContain("x.id IS NULL OR");
  expect(queries[8]).toContain("s.model IS NOT NULL");
  expect(bindings[8]).toEqual([10, 20, 0, "member", 10, 20, 0, "member"]);
  queries.length = 0;
  bindings.length = 0;
  new PullRequestAnalyticsStore(db, { kind: "internal", reason: "audit orphan PRs" }, "on").prepare(
    { startAt: 10, endAt: 20, now: 30 }
  );
  expect(queries.every((sql) => !sql.includes("visibility"))).toBe(true);
  expect(bindings[8]).toEqual([10, 20, 10, 20]);
});
