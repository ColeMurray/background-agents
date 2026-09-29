import { describe, expect, it, vi } from "vitest";
import { AnalyticsStore, mergeBreakdownEntries, scopePredicate } from "./analytics-store";
import type { SqlResult } from "./sql-database";

function result(results: unknown[]): SqlResult {
  return { results, meta: { changes: 0 } };
}

describe("AnalyticsStore row decoding", () => {
  const store = new AnalyticsStore(
    {
      prepare: () => {
        throw new Error("not used");
      },
      batch: async () => {
        throw new Error("not used");
      },
    },
    {
      kind: "user",
      userId: "owner",
      roleKey: "owner",
      permissions: [],
      suspended: false,
      memberships: new Map(),
    },
    "on"
  );

  it("decodes a valid summary row", () => {
    expect(
      store.decodeSummary(
        result([
          {
            total_sessions: 2,
            active_users: 1,
            total_cost: 4,
            private_sessions_cost: 1.5,
            total_prs: 3,
            input_tokens: 2,
            output_tokens: 4,
            reasoning_tokens: 1,
            cache_read_tokens: 6,
            cache_write_tokens: 3,
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
      privateSessionsCostUsd: 1.5,
      avgCost: 2,
      totalPrs: 3,
      inputTokens: 2,
      outputTokens: 4,
      reasoningTokens: 1,
      cacheReadTokens: 6,
      cacheWriteTokens: 3,
      cacheHitRatio: 0.75,
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

  it("returns a null cache hit ratio for an empty summary", () => {
    expect(store.decodeSummary(result([]))).toMatchObject({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRatio: null,
      privateSessionsCostUsd: 0,
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
            input_tokens: 2,
            output_tokens: 4,
            reasoning_tokens: 1,
            cache_read_tokens: 6,
            cache_write_tokens: 3,
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
          inputTokens: 2,
          outputTokens: 4,
          reasoningTokens: 1,
          cacheReadTokens: 6,
          cacheWriteTokens: 3,
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
    input_tokens: 1,
    output_tokens: 2,
    reasoning_tokens: 3,
    cache_read_tokens: 4,
    cache_write_tokens: 5,
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
  it("binds the privileged private-cost query to the same window and scope", () => {
    const queries: string[] = [];
    const bindings: unknown[][] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        bindings.push(values);
        return statement;
      },
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
    };
    const db = {
      prepare: (query: string) => {
        queries.push(query);
        return statement;
      },
      batch: async () => [],
    };
    const filters = { startAt: 10, endAt: 20, scope: "agent" as const };
    new AnalyticsStore(
      db,
      {
        kind: "user",
        userId: "owner",
        roleKey: "owner",
        permissions: [],
        suspended: false,
        memberships: new Map(),
      },
      "on"
    ).prepareSummary(filters);
    expect(queries[0]).toContain("private.spawn_source IN (?)");
    expect(bindings[0]).toEqual([10, 20, "agent", 10, 20, "agent", 1, "owner"]);

    new AnalyticsStore(db, { kind: "service", teamId: null }, "on").prepareSummary(filters);
    expect(queries[1]).toContain("NULL AS private_sessions_cost");
    expect(bindings[1]).toEqual([10, 20, "agent"]);
    const service = new AnalyticsStore(db, { kind: "service", teamId: null }, "on");
    expect(service.decodeSummary(result([])).privateSessionsCostUsd).toBeNull();
    new AnalyticsStore(db, { kind: "internal", reason: "audit all costs" }, "on").prepareSummary(
      filters
    );
    expect(queries[2]).not.toContain("visibility");
    expect(bindings[2]).toEqual([10, 20, "agent"]);
  });

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
    const queries: string[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        binds = values;
        return statement;
      },
      first: vi.fn(),
      run: vi.fn(),
      all: vi.fn(),
    };
    const store = new AnalyticsStore(
      {
        prepare: (query) => {
          sql = query;
          queries.push(query);
          return statement;
        },
        batch: async () => [],
      },
      { kind: "internal", reason: "verify unfiltered billing" },
      "on"
    );
    store.prepareBilling({ startAt: 10, endAt: 20, scope: "agent" });
    expect(sql).toContain(
      "JOIN session_model_provider_auth a ON a.session_id = s.id AND a.auth_mode = 'provider_account'"
    );
    expect(sql).toContain("AND s.spawn_source IN (?)");
    expect(binds).toEqual([10, 20, "agent"]);
    store.prepareBilling({ startAt: 10, endAt: 20, scope: "all" });
    expect(sql).not.toContain("s.spawn_source");
    expect(binds).toEqual([10, 20]);

    const providerStatements = store.prepareProviderBreakdown({
      startAt: 10,
      endAt: 20,
      scope: "agent",
    });
    expect(providerStatements).toHaveLength(2);
    expect(queries.slice(-2)[0]).toContain("s.model AS key");
    expect(queries.slice(-2)[1]).toContain("JOIN session_model_provider_auth a");
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
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
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
        inputTokens: 2,
        outputTokens: 4,
        reasoningTokens: 6,
        cacheReadTokens: 8,
        cacheWriteTokens: 10,
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
        inputTokens: 2,
        outputTokens: 4,
        reasoningTokens: 6,
        cacheReadTokens: 8,
        cacheWriteTokens: 10,
      },
    ]);
  });
});
