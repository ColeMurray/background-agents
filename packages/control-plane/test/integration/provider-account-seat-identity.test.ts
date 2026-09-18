import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { D1ModelProviderAccountAtomicWriter } from "../../src/db/model-provider-account-atomic-writer";
import {
  ProviderAccountAuthorizationStore,
  type ProcessingProviderAuthorization,
} from "../../src/db/provider-account-authorizations";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

// A ChatGPT Business workspace: one subscription, one account id, many seats.
const WORKSPACE = "workspace-integration";
const now = 1_700_000_000_000;

function accounts(): ModelProviderAccountStore {
  return new ModelProviderAccountStore(env.DB);
}

async function seedAccount(
  id: string,
  externalPrincipalId: string | null,
  displayName = "Seat"
): Promise<void> {
  await accounts().create({
    id,
    provider: "openai",
    displayName,
    externalAccountId: WORKSPACE,
    externalPrincipalId,
    now,
  });
  await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
    providerAccountId: id,
    provider: "openai",
    credentialSchemaVersion: 1,
    payload: { refreshToken: `${id}-secret` },
    now,
  });
}

/** Drive a create authorization to the processing state the writer finalizes from. */
async function processingCreateAuthorization(): Promise<
  ProcessingProviderAuthorization & { operation: "create" }
> {
  const listed = await serviceFetch("https://test.local/model-provider-accounts", {
    method: "GET",
  });
  expect(listed.status).toBe(200);
  const started = await serviceFetch(
    "https://test.local/model-provider-accounts/openai/device-authorizations",
    { method: "POST", body: JSON.stringify({ operation: "create", displayName: "Fallback name" }) }
  );
  const { transactionId } = await started.json<{ transactionId: string }>();
  await env.DB.prepare(
    `UPDATE model_provider_account_authorizations
     SET state = 'processing', processing_owner = 'owner-1', processing_started_at = ?
     WHERE id = ?`
  )
    .bind(now, transactionId)
    .run();
  const transaction = await new ProviderAccountAuthorizationStore(env.DB).getOwned(
    "11111111111111111111111111111111",
    transactionId
  );
  return transaction as ProcessingProviderAuthorization & { operation: "create" };
}

describe("provider account seat identity", () => {
  beforeEach(cleanD1Tables);

  it("holds two seats of one subscription as separate accounts", async () => {
    await seedAccount("account-a", "user-a", "a@example.com");
    await seedAccount("account-b", "user-b", "b@example.com");

    const live = await accounts().list("openai");
    expect(live.map((account) => account.externalPrincipalId).sort()).toEqual(["user-a", "user-b"]);
    expect(live.every((account) => account.externalAccountId === WORKSPACE)).toBe(true);
  });

  it("rejects a second account for a seat that already has one", async () => {
    await seedAccount("account-a", "user-a");

    await expect(seedAccount("account-duplicate", "user-a")).rejects.toThrow();
  });

  it("rejects a second unadopted account on one subscription", async () => {
    await seedAccount("account-legacy", null);

    await expect(seedAccount("account-legacy-2", null)).rejects.toThrow();
  });

  it("resolves an account by its seat, and by the absence of one", async () => {
    await seedAccount("account-a", "user-a");
    await seedAccount("account-legacy", null);
    const store = accounts();

    await expect(
      store.findByExternalIdentity("openai", WORKSPACE, "user-a")
    ).resolves.toMatchObject({ id: "account-a" });
    await expect(store.findByExternalIdentity("openai", WORKSPACE, null)).resolves.toMatchObject({
      id: "account-legacy",
    });
    await expect(store.findByExternalIdentity("openai", WORKSPACE, "user-c")).resolves.toBeNull();
  });

  it("creates an account for a new seat and conflicts only on the same seat", async () => {
    await seedAccount("account-a", "user-a");
    const writer = new D1ModelProviderAccountAtomicWriter(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    );

    await expect(
      writer.finalizeDeviceAuthorizationCreate({
        authorization: await processingCreateAuthorization(),
        accountId: "account-b",
        displayName: "b@example.com",
        externalAccountId: WORKSPACE,
        externalPrincipalId: "user-b",
        credential: { refreshToken: "seat-b-secret" },
        credentialSchemaVersion: 1,
        accessTokenExpiresAt: null,
        now,
      })
    ).resolves.toEqual({ type: "created" });
    await expect(accounts().getById("account-b")).resolves.toMatchObject({
      displayName: "b@example.com",
      externalPrincipalId: "user-b",
    });

    await expect(
      writer.finalizeDeviceAuthorizationCreate({
        authorization: await processingCreateAuthorization(),
        accountId: "account-c",
        displayName: "a@example.com",
        externalAccountId: WORKSPACE,
        externalPrincipalId: "user-a",
        credential: { refreshToken: "seat-a-secret" },
        credentialSchemaVersion: 1,
        accessTokenExpiresAt: null,
        now,
      })
    ).resolves.toEqual({ type: "identity_conflict" });
  });

  it("records the seat on an account that was connected without one", async () => {
    await seedAccount("account-legacy", null);
    const writer = new D1ModelProviderAccountAtomicWriter(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    );

    await expect(
      writer.finalizeDeviceAuthorizationReconnect({
        authorization: await processingCreateAuthorization(),
        accountId: "account-legacy",
        externalAccountId: WORKSPACE,
        externalPrincipalId: "user-a",
        credential: { refreshToken: "adopted-secret" },
        credentialSchemaVersion: 1,
        accessTokenExpiresAt: null,
        now: now + 1,
      })
    ).resolves.toEqual({ type: "connected" });
    await expect(accounts().getById("account-legacy")).resolves.toMatchObject({
      externalPrincipalId: "user-a",
    });
  });

  it("refuses to hand an account bound to one seat to another", async () => {
    await seedAccount("account-a", "user-a");
    const writer = new D1ModelProviderAccountAtomicWriter(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    );

    await expect(
      writer.finalizeDeviceAuthorizationReconnect({
        authorization: await processingCreateAuthorization(),
        accountId: "account-a",
        externalAccountId: WORKSPACE,
        externalPrincipalId: "user-b",
        credential: { refreshToken: "seat-b-secret" },
        credentialSchemaVersion: 1,
        accessTokenExpiresAt: null,
        now: now + 1,
      })
    ).resolves.toEqual({ type: "target_changed" });
    const stored = await new ProviderCredentialStore(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    ).readCredentialState<{ refreshToken: string }>("account-a", "openai");
    expect(stored?.payload.refreshToken).toBe("account-a-secret");
  });
});
