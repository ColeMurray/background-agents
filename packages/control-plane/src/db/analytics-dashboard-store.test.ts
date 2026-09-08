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
      return batched.map(() => emptyResult());
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
      startAt: 1_699_395_200_000,
      endAt: 1_700_000_000_000,
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(12);
    expect(batchedStatements).toHaveLength(12);
    expect(batchedStatements.every((statement) => statements.includes(statement))).toBe(true);
    expect(response).toMatchObject({
      generatedAt: 1_700_000_000_000,
      window: {
        days: 7,
        startAt: 1_699_395_200_000,
        endAt: 1_700_000_000_000,
      },
      summary: { totalSessions: 0, totalPrs: 0 },
      breakdowns: { repository: { entries: [] }, user: { entries: [] } },
      pullRequests: { funnel: { created: 0 } },
    });
  });
});
