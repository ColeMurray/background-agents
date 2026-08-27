import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import { ProviderAccountAuthorizationStore } from "./provider-account-authorizations";

function database(batchChanges: number[], firstResults: unknown[] = []) {
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
        async first<T = Record<string, unknown>>() {
          return (firstResults.shift() as T | undefined) ?? null;
        },
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

  it("returns a decoded processing authorization from the claim update", async () => {
    const raw = {
      id: "01".repeat(32),
      user_id: "user-1",
      provider: "openai",
      operation: "create",
      provider_account_id: null,
      target_account_status: null,
      target_account_lifecycle_version: null,
      display_name: "Primary OpenAI",
      encrypted_provider_data: "encrypted",
      provider_state_version: 1,
      interval_ms: 5_000,
      next_poll_at: 100_000,
      expires_at: 700_000,
      state: "processing",
      processing_owner: "owner-1",
      processing_started_at: 100_000,
      result_provider_account_id: null,
      reconnected_existing: null,
      created_at: 1,
      updated_at: 100_000,
      completed_at: null,
    };
    const { db } = database([], [raw]);

    await expect(
      new ProviderAccountAuthorizationStore(db).claim(
        raw.id,
        raw.user_id,
        raw.processing_owner,
        raw.processing_started_at
      )
    ).resolves.toEqual({
      id: raw.id,
      userId: "user-1",
      provider: "openai",
      operation: "create",
      displayName: "Primary OpenAI",
      encryptedProviderData: "encrypted",
      providerStateVersion: 1,
      intervalMs: 5_000,
      nextPollAt: 100_000,
      expiresAt: 700_000,
      state: "processing",
      processingOwner: "owner-1",
      processingStartedAt: 100_000,
      createdAt: 1,
      updatedAt: 100_000,
    });
  });

  it("rejects a pending row whose state-specific provider data is missing", async () => {
    const { db } = database(
      [],
      [
        {
          id: "01".repeat(32),
          user_id: "user-1",
          provider: "openai",
          operation: "create",
          provider_account_id: null,
          target_account_status: null,
          target_account_lifecycle_version: null,
          display_name: "Primary OpenAI",
          encrypted_provider_data: null,
          provider_state_version: 1,
          interval_ms: 5_000,
          next_poll_at: 100_000,
          expires_at: 700_000,
          state: "pending",
          processing_owner: null,
          processing_started_at: null,
          result_provider_account_id: null,
          reconnected_existing: null,
          created_at: 1,
          updated_at: 1,
          completed_at: null,
        },
      ]
    );

    await expect(
      new ProviderAccountAuthorizationStore(db).getOwned("user-1", "01".repeat(32))
    ).rejects.toThrow("Invalid provider authorization provider data");
  });
});
