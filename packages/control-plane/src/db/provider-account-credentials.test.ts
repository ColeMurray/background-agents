import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { ProviderCredentialStore } from "./provider-account-credentials";

describe("ProviderCredentialStore.listDueRefreshAccountIds", () => {
  it("selects only bounded active account IDs in deterministic expiry order", async () => {
    let query = "";
    let bindings: unknown[] = [];
    const statement: SqlStatement = {
      bind: vi.fn((...values: unknown[]) => {
        bindings = values;
        return statement;
      }),
      first: vi.fn(async () => null),
      run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      all: async <T>() => ({
        results: [{ id: "account-1" }, { id: "account-2" }] as T[],
        meta: { changes: 0 },
      }),
    };
    const db: SqlDatabase = {
      prepare(sql) {
        query = sql;
        return statement;
      },
      batch: vi.fn(async () => []),
    };

    const ids = await new ProviderCredentialStore(db, "unused").listDueRefreshAccountIds(
      "anthropic",
      1_360_000,
      50
    );

    expect(ids).toEqual(["account-1", "account-2"]);
    expect(bindings).toEqual(["anthropic", 1_360_000, 50]);
    expect(query).toContain("accounts.status = 'active'");
    expect(query).toContain("accounts.archived_at IS NULL");
    expect(query).toContain("credentials.access_token_expires_at IS NOT NULL");
    expect(query).toContain("credentials.access_token_expires_at <= ?");
    expect(query).toContain("ORDER BY credentials.access_token_expires_at, accounts.id");
    expect(query).toContain("LIMIT ?");
    expect(query).not.toContain("encrypted_payload");
  });
});
