import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { AnalyticsDashboardStore } from "./analytics-dashboard-store";

function emptyResult(): SqlResult {
  return { results: [], meta: { changes: 0 } };
}

describe("AnalyticsDashboardStore", () => {
  it("reads every dashboard resource in one database batch", async () => {
    const statements: SqlStatement[] = [];
    let batchedStatements: SqlStatement[] = [];
    const batch = vi.fn(async (batched: SqlStatement[]) => {
      batchedStatements = batched;
      return batched.map((_, index) => {
        if (index === 7)
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
              },
            ],
          };
        return emptyResult();
      });
    });
    const db = {
      prepare: vi.fn(() => {
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
    const store = new AnalyticsDashboardStore(db);

    const response = await store.get({
      days: 7,
      scope: "agent",
      startAt: 1_699_395_200_000,
      endAt: 1_700_000_000_000,
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(16);
    expect(batchedStatements).toHaveLength(16);
    expect(batchedStatements.every((statement) => statements.includes(statement))).toBe(true);
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
    });
  });
});
