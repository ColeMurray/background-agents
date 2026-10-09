import { describe, expect, it, vi } from "vitest";
import { ProviderDefaultStore } from "./provider-account-defaults";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

function database(options: { first?: unknown; all?: unknown[] }) {
  const db: SqlDatabase = {
    prepare(): SqlStatement {
      const statement: SqlStatement = {
        bind: vi.fn(() => statement),
        async first<T = Record<string, unknown>>() {
          return (options.first as T | undefined) ?? null;
        },
        async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
          return { results: (options.all ?? []) as T[], meta: { changes: 0 } };
        },
        run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      };
      return statement;
    },
    async batch<T = unknown>() {
      return [] as SqlResult<T>[];
    },
  };
  return db;
}

const validRow = {
  provider: "openai",
  provider_account_id: "01".repeat(16),
  unattended_mode: "provider_account",
  created_by: null,
  updated_by: null,
  created_at: 1,
  updated_at: 2,
};

describe("ProviderDefaultStore", () => {
  it("returns a provider default row with nullable audit fields", async () => {
    await expect(
      new ProviderDefaultStore(database({ first: validRow })).get("openai")
    ).resolves.toEqual({
      provider: "openai",
      providerAccountId: "01".repeat(16),
      unattendedMode: "provider_account",
      createdBy: null,
      updatedBy: null,
      createdAt: 1,
      updatedAt: 2,
    });
  });

  it("rejects a partial persisted provider default row", async () => {
    await expect(
      new ProviderDefaultStore(database({ first: { provider: "openai" } })).get("openai")
    ).rejects.toThrow("Invalid provider default row");
  });

  it("rejects malformed provider default rows from list reads", async () => {
    await expect(
      new ProviderDefaultStore(
        database({ all: [{ ...validRow, unattended_mode: "unknown_mode" }] })
      ).list()
    ).rejects.toThrow("Invalid provider default row");
  });
});
