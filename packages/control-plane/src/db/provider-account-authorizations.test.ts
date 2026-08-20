import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { ProviderAccountAuthorizationStore } from "./provider-account-authorizations";

function database(batchChanges: number[]) {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const db: SqlDatabase = {
    prepare(query: string): SqlStatement {
      const recorded = { query, values: [] as unknown[] };
      statements.push(recorded);
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          recorded.values = values;
          return statement;
        },
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
        all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      };
      return statement;
    },
    async batch<T = unknown>() {
      return batchChanges.map((changes): SqlResult<T> => ({ results: [], meta: { changes } }));
    },
  };
  return { db, statements };
}

describe("ProviderAccountAuthorizationStore", () => {
  it("keeps the rolling attempt budget independent from transaction cleanup", async () => {
    const { db, statements } = database([2, 3, 1]);
    const store = new ProviderAccountAuthorizationStore(db);

    await expect(store.recordAttempt("01".repeat(32), "user-1", 120_000)).resolves.toBe(true);
    expect(statements).toHaveLength(3);
    expect(statements[2].values).toEqual(["01".repeat(32), "user-1", 120_000, "user-1", 60_000]);
  });

  it("reserves before superseding and reports a rejected live-attempt reservation", async () => {
    const { db, statements } = database([0, 0]);
    const store = new ProviderAccountAuthorizationStore(db);
    await expect(
      store.reserve({
        id: "01".repeat(32),
        userId: "user-1",
        provider: "openai",
        operation: "reconnect",
        providerAccountId: "02".repeat(16),
        targetAccountStatus: "active",
        targetAccountLifecycleVersion: 3,
        displayName: null,
        expiresAt: 700_000,
        now: 100_000,
      })
    ).resolves.toBe(false);
    expect(statements).toHaveLength(2);
  });
});
