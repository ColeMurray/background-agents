import { describe, expect, it, vi } from "vitest";
import { AutomationStore } from "./automation-store";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

function createStatement(result: SqlResult = { results: [], meta: { changes: 0 } }) {
  const statement = {
    bind: vi.fn(() => statement),
    all: vi.fn(async () => result),
    first: vi.fn(),
    run: vi.fn(),
  } as unknown as SqlStatement;
  return statement;
}

function createStore(pageRows: unknown[]) {
  const childStatement = createStatement();
  const db = {
    batch: vi.fn(async () => [
      { results: [{ count: pageRows.length }], meta: { changes: 0 } },
      { results: pageRows, meta: { changes: 0 } },
    ]),
    prepare: vi.fn(() => childStatement),
  } as unknown as SqlDatabase;

  return { store: new AutomationStore(db), childStatement };
}

describe("AutomationStore listInvocations row parsing", () => {
  it("parses valid invocation rows, including nullable schedule and completion fields", async () => {
    const { store } = createStore([
      {
        id: "inv-1",
        automation_id: "auto-1",
        source: "manual",
        scheduled_at: null,
        skip_reason: null,
        created_at: 1000,
        derived_status: "running",
        derived_completed_at: null,
      },
    ]);

    await expect(store.listInvocations("auto-1", { limit: 10, offset: 0 })).resolves.toEqual({
      total: 1,
      invocations: [
        {
          id: "inv-1",
          automationId: "auto-1",
          status: "running",
          source: "manual",
          scheduledAt: null,
          skipReason: null,
          createdAt: 1000,
          completedAt: null,
          runs: [],
        },
      ],
    });
  });

  it("rejects malformed invocation rows before exposing API state", async () => {
    const { store, childStatement } = createStore([
      {
        id: "inv-1",
        automation_id: "auto-1",
        source: "manual",
        scheduled_at: null,
        skip_reason: null,
        created_at: 1000,
        derived_status: "bogus",
        derived_completed_at: null,
      },
    ]);

    await expect(store.listInvocations("auto-1", { limit: 10, offset: 0 })).resolves.toEqual({
      total: 1,
      invocations: [],
    });
    expect(childStatement.all).not.toHaveBeenCalled();
  });
});
