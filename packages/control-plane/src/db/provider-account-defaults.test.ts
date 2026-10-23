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
  provider_account_id: "first-account",
  unattended_mode: "provider_account",
  created_by: null,
  updated_by: null,
  created_at: 1,
  updated_at: 2,
};

describe("ProviderDefaultStore", () => {
  it("returns a provider default row with nullable audit fields and existing text IDs", async () => {
    await expect(
      new ProviderDefaultStore(database({ first: validRow })).get("openai")
    ).resolves.toEqual({
      provider: "openai",
      providerAccountId: "first-account",
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

  it("rejects invalid persisted audit and timestamp fields", async () => {
    await expect(
      new ProviderDefaultStore(database({ first: { ...validRow, created_by: "" } })).get("openai")
    ).rejects.toThrow("Invalid provider default row");

    await expect(
      new ProviderDefaultStore(database({ first: { ...validRow, created_at: -1 } })).get("openai")
    ).rejects.toThrow("Invalid provider default row");
  });

  it("rejects invalid audit and timestamp fields before writing", async () => {
    const store = new ProviderDefaultStore(database({}));

    await expect(store.set("openai", "account-auth", "api_key", "", 1)).rejects.toThrow(
      "Invalid provider default write"
    );
    await expect(store.set("openai", "account-auth", "api_key", null, -1)).rejects.toThrow(
      "Invalid provider default write"
    );
    expect(() => store.bindSetForFirstActiveAccount("account-auth", "openai", "", 1)).toThrow(
      "Invalid provider default write"
    );
  });
});
