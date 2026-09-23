import { describe, expect, it, vi } from "vitest";
import { encryptProviderAccountPayload } from "../auth/provider-account-crypto";
import { generateEncryptionKey } from "../auth/crypto";
import { ProviderCredentialStore } from "./provider-account-credentials";
import type { SqlDatabase, SqlStatement } from "./sql-database";

function database(row: Record<string, unknown> | null): SqlDatabase {
  return {
    prepare(): SqlStatement {
      const statement: SqlStatement = {
        bind: () => statement,
        async first<T>() {
          return row as T | null;
        },
        run: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
        all: vi.fn(async () => ({ results: [], meta: { changes: 0 } })),
      };
      return statement;
    },
    batch: vi.fn(async () => []),
  };
}

async function validCredentialRow(encryptionKey: string): Promise<Record<string, unknown>> {
  return {
    encrypted_payload: await encryptProviderAccountPayload({ token: "secret" }, encryptionKey, {
      providerAccountId: "account-1",
      provider: "openai",
      credentialSchemaVersion: 1,
    }),
    credential_schema_version: 1,
    credential_version: 2,
    exchange_generation: 3,
    exchange_state: "idle",
    exchange_owner: null,
    exchange_started_at: null,
    access_token_expires_at: null,
    updated_at: 4,
  };
}

describe("ProviderCredentialStore credential rows", () => {
  it("returns a decrypted credential state from a valid row with nullable fields", async () => {
    const encryptionKey = generateEncryptionKey();
    const store = new ProviderCredentialStore(
      database(await validCredentialRow(encryptionKey)),
      encryptionKey
    );

    await expect(store.readCredentialState("account-1", "openai")).resolves.toEqual({
      payload: { token: "secret" },
      credentialSchemaVersion: 1,
      credentialVersion: 2,
      exchangeGeneration: 3,
      exchangeState: "idle",
      exchangeOwner: null,
      exchangeStartedAt: null,
      accessTokenExpiresAt: null,
      updatedAt: 4,
    });
  });

  it("returns null when no credential row exists", async () => {
    const encryptionKey = generateEncryptionKey();
    const store = new ProviderCredentialStore(database(null), encryptionKey);

    await expect(store.readCredentialState("account-1", "openai")).resolves.toBeNull();
  });

  it("throws a credential integrity error for a malformed credential row", async () => {
    const encryptionKey = generateEncryptionKey();
    const store = new ProviderCredentialStore(
      database({
        encrypted_payload: 123,
        credential_schema_version: 1,
        credential_version: 2,
        exchange_generation: 3,
        exchange_state: "idle",
        exchange_owner: null,
        exchange_started_at: null,
        access_token_expires_at: null,
        updated_at: 4,
      }),
      encryptionKey
    );

    await expect(store.readCredentialState("account-1", "openai")).rejects.toThrow(
      "Malformed provider credential row for account account-1"
    );
  });

  it("rejects a partial credential row", async () => {
    const encryptionKey = generateEncryptionKey();
    const store = new ProviderCredentialStore(
      database({
        encrypted_payload: "unused",
        credential_schema_version: 1,
        credential_version: 2,
        exchange_generation: 3,
        exchange_state: "idle",
        exchange_owner: null,
        exchange_started_at: null,
        access_token_expires_at: null,
      }),
      encryptionKey
    );

    await expect(store.readCredentialState("account-1", "openai")).rejects.toThrow(
      "Malformed provider credential row for account account-1"
    );
  });

  it.each([
    ["fractional schema version", { credential_schema_version: 1.5 }],
    ["negative credential version", { credential_version: -1 }],
    ["negative exchange generation", { exchange_generation: -1 }],
    ["idle exchange with owner", { exchange_owner: "owner-1" }],
    ["idle exchange with start time", { exchange_started_at: 1_000 }],
    [
      "in-flight exchange without owner",
      { exchange_state: "in_flight", exchange_owner: null, exchange_started_at: 1_000 },
    ],
    [
      "in-flight exchange without start time",
      { exchange_state: "in_flight", exchange_owner: "owner-1", exchange_started_at: null },
    ],
  ])("rejects %s", async (_description, override) => {
    const encryptionKey = generateEncryptionKey();
    const store = new ProviderCredentialStore(
      database({ ...(await validCredentialRow(encryptionKey)), ...override }),
      encryptionKey
    );

    await expect(store.readCredentialState("account-1", "openai")).rejects.toThrow(
      "Malformed provider credential row for account account-1"
    );
  });
});
