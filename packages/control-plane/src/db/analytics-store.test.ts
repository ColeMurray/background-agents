import { describe, expect, it, vi } from "vitest";
import { AnalyticsStore, mergeBreakdownEntries, scopePredicate } from "./analytics-store";
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
        ]),
        "repo"
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
        ]),
        "repo"
      )
    ).toThrow("Invalid analytics breakdown row");
  });

  const row = (key: string, extras: Record<string, unknown> = {}) => ({
    key,
    display_name: null,
    sessions: 1,
    completed: 1,
    failed: 0,
    cancelled: 0,
    cost: 2,
    prs: 1,
    message_count: 3,
    avg_duration: 100,
    last_active: 200,
    ...extras,
  });

  it("decodes model, harness, spawn source and automation rows", () => {
    expect(store.decodeBreakdown(result([row("claude-haiku-4-5")]), "model").entries).toEqual([
      expect.objectContaining({
        key: "anthropic/claude-haiku-4-5",
        displayName: "Claude Haiku 4.5",
      }),
    ]);
    expect(store.decodeBreakdown(result([row("opencode")]), "harness").entries).toEqual([
      expect.objectContaining({ key: "opencode", displayName: "OpenCode" }),
    ]);
    expect(
      store.decodeBreakdown(result([row("agent")]), "spawnSource").entries[0]
    ).not.toHaveProperty("displayName");
    expect(
      store.decodeBreakdown(result([row("automation-1", { display_name: "Daily" })]), "automation")
        .entries
    ).toEqual([expect.objectContaining({ key: "automation-1", displayName: "Daily" })]);
    expect(() =>
      store.decodeBreakdown(result([row("automation-1", { sessions: "1" })]), "automation")
    ).toThrow("Invalid analytics breakdown row");
  });

  it("counts billing rows only for the model's actual provider", () => {
    const models = store.decodeBreakdown(
      result([row("openai/gpt-5"), row("anthropic/claude-haiku-4-5")]),
      "model"
    );
    expect(models.entries[0]).not.toHaveProperty("subscriptionSessions");
    expect(
      store.decodeProviderBreakdown(
        models,
        result([
          { model: "openai/gpt-5", provider: "openai", sessions: 2 },
          { model: "openai/gpt-5", provider: "anthropic", sessions: 99 },
        ])
      ).entries
    ).toEqual([
      expect.objectContaining({ key: "anthropic", subscriptionSessions: 0 }),
      expect.objectContaining({ key: "openai", subscriptionSessions: 2 }),
    ]);
    expect(() =>
      store.decodeProviderBreakdown(
        models,
        result([{ model: "openai/gpt-5", provider: "openai", sessions: "2" }])
      )
    ).toThrow("Invalid analytics billing row");
  });
});

describe("scope and breakdown merging", () => {
  it("uses the exact human population and no predicate for all", () => {
    expect(scopePredicate("human", "s.spawn_source")).toEqual({
      sql: "AND s.spawn_source IN (?, ?, ?, ?)",
      binds: ["user", "slack-bot", "linear-bot", "github-bot"],
    });
    expect(scopePredicate("agent", "spawn_source")).toEqual({
      sql: "AND spawn_source IN (?)",
      binds: ["agent"],
    });
    expect(scopePredicate("all", "s.spawn_source")).toEqual({ sql: "", binds: [] });
  });

  it("filters billing on the session's qualified spawn source with positional binds", () => {
    let sql = "";
    let binds: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        binds = values;
        return statement;
      },
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
    };
    const store = new AnalyticsStore({
      prepare: (query) => {
        sql = query;
        return statement;
      },
      batch: async () => [],
    });
    store.prepareBilling({ startAt: 10, endAt: 20, scope: "agent" });
    expect(sql).toContain(
      "JOIN session_model_provider_auth a ON a.session_id = s.id AND a.auth_mode = 'provider_account'"
    );
    expect(sql).toContain("AND s.spawn_source IN (?)");
    expect(binds).toEqual([10, 20, "agent"]);
    store.prepareBilling({ startAt: 10, endAt: 20, scope: "all" });
    expect(sql).not.toContain("s.spawn_source");
    expect(binds).toEqual([10, 20]);
  });

  it("merges weighted terminal durations, zero-terminal rows, totals, last active and sorts by key on ties", () => {
    const entry = (key: string, completed: number, avgDuration: number) => ({
      key,
      sessions: 2,
      completed,
      failed: 0,
      cancelled: 0,
      cost: 1,
      prs: 1,
      messageCount: 3,
      avgDuration,
      lastActive: avgDuration,
    });
    expect(
      mergeBreakdownEntries(
        [
          entry("z/one", 1, 100),
          entry("a/other", 0, 900),
          entry("z/two", 3, 300),
          entry("a/second", 0, 400),
        ],
        (item) => item.key[0],
        (key) => key.toUpperCase()
      )
    ).toEqual([
      {
        key: "a",
        displayName: "A",
        sessions: 4,
        completed: 0,
        failed: 0,
        cancelled: 0,
        cost: 2,
        prs: 2,
        messageCount: 6,
        avgDuration: 0,
        lastActive: 900,
      },
      {
        key: "z",
        displayName: "Z",
        sessions: 4,
        completed: 4,
        failed: 0,
        cancelled: 0,
        cost: 2,
        prs: 2,
        messageCount: 6,
        avgDuration: 250,
        lastActive: 300,
      },
    ]);
  });
});
