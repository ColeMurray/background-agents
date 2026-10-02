import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { AnalyticsDashboardStore, DASHBOARD_RUNS_LIMIT } from "./analytics-dashboard-store";

function emptyResult(): SqlResult {
  return { results: [], meta: { changes: 0 } };
}

describe("AnalyticsDashboardStore", () => {
  it("reads every dashboard resource in one database batch", async () => {
    const statements: SqlStatement[] = [];
    const queries: string[] = [];
    let batchedStatements: SqlStatement[] = [];
    const batch = vi.fn(async (batched: SqlStatement[]) => {
      batchedStatements = batched;
      return batched.map((_, index) => {
        if (index === 8)
          return {
            ...emptyResult(),
            results: [{ model: "openai/gpt-5", provider: "openai", sessions: 1 }],
          };
        if (index === 4 || index === 6)
          return {
            ...emptyResult(),
            results: [
              {
                key: index === 4 ? "openai/gpt-5" : "agent",
                display_name: null,
                sessions: 1,
                completed: 1,
                failed: 0,
                cancelled: 0,
                cost: 1,
                prs: 0,
                message_count: 1,
                avg_duration: 100,
                last_active: 200,
                input_tokens: 1,
                output_tokens: 2,
                reasoning_tokens: 0,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
              },
            ],
          };
        if (index === 19)
          return {
            ...emptyResult(),
            results: [
              {
                root_session_id: "root",
                title: null,
                session_count: 1,
                max_spawn_depth: 0,
                total_cost: 2,
                total_prs: 0,
                input_tokens: 1,
                output_tokens: 2,
                reasoning_tokens: 0,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                created_at: 10,
                updated_at: 11,
                user_id: null,
                scm_login: null,
                spawn_source: "agent",
                automation_id: null,
                repo_owner: null,
                repo_name: null,
              },
            ],
          };
        return emptyResult();
      });
    });
    const db = {
      prepare: vi.fn((query: string) => {
        queries.push(query);
        const statement: SqlStatement = {
          bind: vi.fn(() => statement),
          first: vi.fn(),
          run: vi.fn(),
          all: vi.fn(),
        };
        statements.push(statement);
        return statement;
      }),
      batch: batch as SqlDatabase["batch"],
    };
    const store = new AnalyticsDashboardStore(
      db,
      { kind: "internal", reason: "verify batch" },
      "on"
    );

    const response = await store.get({
      days: 7,
      scope: "agent",
      startAt: 1_699_395_200_000,
      endAt: 1_700_000_000_000,
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(20);
    expect(batchedStatements).toHaveLength(20);
    expect(batchedStatements.every((statement) => statements.includes(statement))).toBe(true);
    expect(queries[19]).toContain("root.spawn_source IN (?)");
    expect(statements[19].bind).toHaveBeenCalledWith(
      1_699_395_200_000,
      1_700_000_000_000,
      "agent",
      DASHBOARD_RUNS_LIMIT
    );
    expect(response).toMatchObject({
      generatedAt: 1_700_000_000_000,
      window: {
        days: 7,
        scope: "agent",
        startAt: 1_699_395_200_000,
        endAt: 1_700_000_000_000,
      },
      summary: { totalSessions: 0, totalPrs: 0 },
      breakdowns: {
        repository: { entries: [] },
        user: { entries: [] },
        model: { entries: [{ key: "openai/gpt-5" }] },
        harness: { entries: [] },
        automation: { entries: [{ key: "agent" }] },
        provider: { entries: [{ key: "openai", subscriptionSessions: 1 }] },
      },
      pullRequests: { funnel: { created: 0 } },
      runs: [{ rootSessionId: "root", title: null }],
    });
  });
});
