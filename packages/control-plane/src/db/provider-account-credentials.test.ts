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

describe("ProviderCredentialStore credential rows", () => {
  it("returns a decrypted credential state from a valid row with nullable fields", async () => {
    const encryptionKey = generateEncryptionKey();
    const encryptedPayload = await encryptProviderAccountPayload(
      { token: "secret" },
      encryptionKey,
      {
        providerAccountId: "account-1",
        provider: "openai",
        credentialSchemaVersion: 1,
      }
    );
    const store = new ProviderCredentialStore(
      database({
        encrypted_payload: encryptedPayload,
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

  it("rejects a malformed credential row before decrypting it", async () => {
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

    await expect(store.readCredentialState("account-1", "openai")).resolves.toBeNull();
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

    await expect(store.readCredentialState("account-1", "openai")).resolves.toBeNull();
  });
});
