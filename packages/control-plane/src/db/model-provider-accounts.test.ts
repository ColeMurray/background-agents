import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { ModelProviderAccountStore } from "./model-provider-accounts";

function database(row: Record<string, unknown> | null = null) {
  const queries: string[] = [];
  const db: SqlDatabase = {
    prepare(query) {
      queries.push(query);
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() => row as T | null,
        run: vi.fn(async () => ({ results: [], meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      };
      return statement;
    },
    batch: vi.fn(async () => []),
  };
  return { db, queries };
}

describe("ModelProviderAccountStore lifecycle version", () => {
  it("returns an internal lifecycle snapshot without extending the account contract", async () => {
    const { db } = database({
      id: "account-1",
      provider: "openai",
      display_name: "OpenAI",
      external_account_id: "external-1",
      status: "active",
      created_by: null,
      updated_by: null,
      last_verified_at: null,
      last_used_at: null,
      created_at: 1,
      updated_at: 2,
      archived_at: null,
      lifecycle_version: 3,
    });

    const snapshot = await new ModelProviderAccountStore(db).getLifecycleSnapshot("account-1");

    expect(snapshot?.lifecycleVersion).toBe(3);
    expect(snapshot?.account).not.toHaveProperty("lifecycleVersion");
  });

  it("increments lifecycle mutations but not rename or last-used metadata", async () => {
    const { db, queries } = database();
    const store = new ModelProviderAccountStore(db);

    store.bindUpdateConnection("account-1", {
      externalAccountId: "external-1",
      status: "active",
      actorId: "user-1",
      lastVerifiedAt: 10,
      now: 10,
      credentialVersion: 2,
      encryptedPayload: "encrypted",
    });
    await store.setStatus("account-1", "disabled", "user-1", 11);
    await store.archive("account-1", "user-1", 12);
    await store.updateDetails("account-1", { displayName: "Renamed", now: 13 });
    await store.touchLastUsed("account-1", 13, 14);

    expect(queries.slice(0, 3).every((query) => query.includes("lifecycle_version + 1"))).toBe(
      true
    );
    expect(queries.slice(3).every((query) => !query.includes("lifecycle_version"))).toBe(true);
  });
});
