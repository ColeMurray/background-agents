import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateEncryptionKey } from "../../src/auth/crypto";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { D1ModelProviderAccountAtomicWriter } from "../../src/db/model-provider-account-atomic-writer";
import { cleanD1Tables } from "./cleanup";

const NOW = 1_700_000_000_000;

async function seedAccount(
  id: string,
  status: "active" | "disabled" | "reconnect_required"
): Promise<{
  accounts: ModelProviderAccountStore;
  credentials: ProviderCredentialStore;
  writer: D1ModelProviderAccountAtomicWriter;
}> {
  const key = generateEncryptionKey();
  const accounts = new ModelProviderAccountStore(env.DB);
  const credentials = new ProviderCredentialStore(env.DB, key);
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, email, created_at, updated_at)
     VALUES ('user-1', 'Test User', 'user@example.com', ?, ?)`
  )
    .bind(NOW, NOW)
    .run();
  await accounts.create({
    id,
    provider: "openai",
    displayName: "Atomic account",
    externalAccountId: `acct-${id}`,
    status,
    now: NOW,
  });
  await credentials.create({
    providerAccountId: id,
    provider: "openai",
    credentialSchemaVersion: 1,
    payload: { refreshToken: "old-secret" },
    now: NOW,
  });
  return {
    accounts,
    credentials,
    writer: new D1ModelProviderAccountAtomicWriter(env.DB, key),
  };
}

describe("provider account atomic persistence", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("allows only one durable verification claim to dispatch", async () => {
    const { credentials } = await seedAccount("claim-race", "reconnect_required");

    const claims = await Promise.all([
      credentials.tryBeginExchange("claim-race", 1, "owner-a", "reconnect_required", NOW + 1),
      credentials.tryBeginExchange("claim-race", 1, "owner-b", "reconnect_required", NOW + 1),
    ]);

    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
  });

  it("atomically fences an observed lease and marks its account reconnect required", async () => {
    const { accounts, credentials, writer } = await seedAccount("terminal-failure", "active");
    await credentials.tryBeginExchange("terminal-failure", 1, "owner-a", "active", NOW + 1);

    await expect(
      writer.fenceExchangeAndRequireReconnect({
        providerAccountId: "terminal-failure",
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        now: NOW + 2,
      })
    ).resolves.toBe(true);
    await expect(
      credentials.readCredentialState("terminal-failure", "openai")
    ).resolves.toMatchObject({
      credentialVersion: 1,
      exchangeGeneration: 2,
      exchangeState: "idle",
      exchangeOwner: null,
      exchangeStartedAt: null,
    });
    await expect(accounts.getById("terminal-failure")).resolves.toMatchObject({
      status: "reconnect_required",
    });
  });

  it("rejects a late completion after terminal failure fences its lease", async () => {
    const { credentials, writer } = await seedAccount("late-completion", "active");
    await credentials.tryBeginExchange("late-completion", 1, "owner-a", "active", NOW + 1);
    await writer.fenceExchangeAndRequireReconnect({
      providerAccountId: "late-completion",
      credentialVersion: 1,
      exchangeGeneration: 1,
      exchangeOwner: "owner-a",
      now: NOW + 2,
    });

    await expect(
      credentials.completeExchange({
        providerAccountId: "late-completion",
        provider: "openai",
        expectedCredentialVersion: 1,
        expectedAccountStatus: "active",
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        credentialSchemaVersion: 1,
        payload: { refreshToken: "late-secret" },
        now: NOW + 3,
      })
    ).resolves.toBe(false);
    await expect(
      credentials.readCredentialState("late-completion", "openai")
    ).resolves.toMatchObject({ credentialVersion: 1, payload: { refreshToken: "old-secret" } });
  });

  it("leaves both rows unchanged when the observed lease is stale", async () => {
    const { accounts, credentials, writer } = await seedAccount("stale-observation", "active");
    await credentials.tryBeginExchange("stale-observation", 1, "owner-a", "active", NOW + 1);

    await expect(
      writer.fenceExchangeAndRequireReconnect({
        providerAccountId: "stale-observation",
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: "late-owner",
        now: NOW + 2,
      })
    ).resolves.toBe(false);
    await expect(
      credentials.readCredentialState("stale-observation", "openai")
    ).resolves.toMatchObject({
      exchangeGeneration: 1,
      exchangeState: "in_flight",
      exchangeOwner: "owner-a",
    });
    await expect(accounts.getById("stale-observation")).resolves.toMatchObject({
      status: "active",
    });
  });

  it("rolls back the account transition when the lease fence cannot commit", async () => {
    const { accounts, credentials, writer } = await seedAccount("terminal-rollback", "active");
    await credentials.tryBeginExchange("terminal-rollback", 1, "owner-a", "active", NOW + 1);
    await env.DB.prepare(
      `CREATE TRIGGER fail_terminal_credential_fence
       BEFORE UPDATE OF exchange_state ON model_provider_account_credentials
       WHEN NEW.provider_account_id = 'terminal-rollback'
       BEGIN
         SELECT RAISE(ABORT, 'forced terminal fence failure');
       END`
    ).run();
    try {
      await expect(
        writer.fenceExchangeAndRequireReconnect({
          providerAccountId: "terminal-rollback",
          credentialVersion: 1,
          exchangeGeneration: 1,
          exchangeOwner: "owner-a",
          now: NOW + 2,
        })
      ).rejects.toThrow(/forced terminal fence failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_terminal_credential_fence").run();
    }

    await expect(
      credentials.readCredentialState("terminal-rollback", "openai")
    ).resolves.toMatchObject({
      exchangeGeneration: 1,
      exchangeState: "in_flight",
      exchangeOwner: "owner-a",
    });
    await expect(accounts.getById("terminal-rollback")).resolves.toMatchObject({
      status: "active",
    });
  });

  it("clears a retry-safe lease without changing account status", async () => {
    const { accounts, credentials } = await seedAccount("retry-safe", "active");
    await credentials.tryBeginExchange("retry-safe", 1, "owner-a", "active", NOW + 1);

    await expect(
      credentials.clearSafeFailure("retry-safe", 1, 1, "owner-a", NOW + 2)
    ).resolves.toBe(true);
    await expect(credentials.readCredentialState("retry-safe", "openai")).resolves.toMatchObject({
      exchangeState: "idle",
      exchangeGeneration: 1,
    });
    await expect(accounts.getById("retry-safe")).resolves.toMatchObject({ status: "active" });
  });

  it("keeps disabled as a supported durable account status", async () => {
    const { accounts, credentials } = await seedAccount("disabled-account", "disabled");
    await expect(accounts.getById("disabled-account")).resolves.toMatchObject({
      status: "disabled",
      archivedAt: null,
    });
    await expect(
      credentials.tryBeginExchange("disabled-account", 1, "owner-a", "active", NOW + 1)
    ).resolves.toEqual({ acquired: false });
  });

  it("rejects a credential claim after the account is archived", async () => {
    const { accounts, credentials } = await seedAccount("archived-account", "active");
    await accounts.archive("archived-account", "user-1", NOW + 1);

    await expect(
      credentials.tryBeginExchange("archived-account", 1, "owner-a", "active", NOW + 2)
    ).resolves.toEqual({ acquired: false });
  });

  it("reports a lost fence without clearing the lease after an operator disable", async () => {
    const { accounts, credentials, writer } = await seedAccount(
      "disabled-during-exchange",
      "active"
    );
    await credentials.tryBeginExchange("disabled-during-exchange", 1, "owner-a", "active", NOW + 1);
    await accounts.setStatus("disabled-during-exchange", "disabled", "user-1", NOW + 2);

    await expect(
      credentials.completeExchange({
        providerAccountId: "disabled-during-exchange",
        provider: "openai",
        expectedCredentialVersion: 1,
        expectedAccountStatus: "active",
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        credentialSchemaVersion: 1,
        payload: { refreshToken: "new-secret" },
        now: NOW + 3,
      })
    ).resolves.toBe(false);

    await expect(
      writer.fenceExchangeAndRequireReconnect({
        providerAccountId: "disabled-during-exchange",
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        now: NOW + 4,
      })
    ).resolves.toBe(false);
    await expect(accounts.getById("disabled-during-exchange")).resolves.toMatchObject({
      status: "disabled",
      updatedBy: "user-1",
      updatedAt: NOW + 2,
    });
    await expect(
      credentials.readCredentialState("disabled-during-exchange", "openai")
    ).resolves.toMatchObject({
      exchangeState: "in_flight",
      exchangeGeneration: 1,
      exchangeOwner: "owner-a",
    });
  });

  it("reports a lost fence without clearing the lease after archival", async () => {
    const { accounts, credentials, writer } = await seedAccount(
      "archived-during-exchange",
      "active"
    );
    await credentials.tryBeginExchange("archived-during-exchange", 1, "owner-a", "active", NOW + 1);
    await accounts.archive("archived-during-exchange", "user-1", NOW + 2);

    await expect(
      writer.fenceExchangeAndRequireReconnect({
        providerAccountId: "archived-during-exchange",
        credentialVersion: 1,
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        now: NOW + 3,
      })
    ).resolves.toBe(false);
    await expect(accounts.getById("archived-during-exchange")).resolves.toMatchObject({
      status: "active",
      archivedAt: NOW + 2,
    });
    await expect(
      credentials.readCredentialState("archived-during-exchange", "openai")
    ).resolves.toMatchObject({
      exchangeState: "in_flight",
      exchangeGeneration: 1,
      exchangeOwner: "owner-a",
    });
  });

  it("rejects interrupted as a credential exchange state", async () => {
    await seedAccount("invalid-state", "active");
    await expect(
      env.DB.prepare(
        "UPDATE model_provider_account_credentials SET exchange_state = 'interrupted' WHERE provider_account_id = ?"
      )
        .bind("invalid-state")
        .run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rolls back fenced verification credentials when account state cannot update", async () => {
    const { accounts, credentials, writer } = await seedAccount(
      "atomic-verify",
      "reconnect_required"
    );
    await credentials.tryBeginExchange(
      "atomic-verify",
      1,
      "verify-owner",
      "reconnect_required",
      NOW + 1
    );
    await env.DB.prepare(
      `CREATE TRIGGER fail_verified_account_update
       BEFORE UPDATE OF status ON model_provider_accounts
       WHEN NEW.id = 'atomic-verify'
       BEGIN
         SELECT RAISE(ABORT, 'forced account verification failure');
       END`
    ).run();
    try {
      await expect(
        writer.completeVerificationCredentialAndAccount({
          providerAccountId: "atomic-verify",
          provider: "openai",
          credentialSchemaVersion: 1,
          expectedCredentialVersion: 1,
          expectedAccountStatus: "reconnect_required",
          exchangeGeneration: 1,
          exchangeOwner: "verify-owner",
          payload: { refreshToken: "new-secret" },
          externalAccountId: "acct-atomic-verify",
          status: "active",
          actorId: "user-1",
          lastVerifiedAt: NOW + 2,
          now: NOW + 2,
        })
      ).rejects.toThrow(/forced account verification failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_verified_account_update").run();
    }

    await expect(credentials.readCredentialState("atomic-verify", "openai")).resolves.toMatchObject(
      {
        credentialVersion: 1,
        exchangeState: "in_flight",
        payload: { refreshToken: "old-secret" },
      }
    );
    await expect(accounts.getById("atomic-verify")).resolves.toMatchObject({
      status: "reconnect_required",
      lastVerifiedAt: null,
    });
  });

  it("rolls back reconnect credentials when account state cannot update", async () => {
    const { accounts, credentials, writer } = await seedAccount(
      "atomic-reconnect",
      "reconnect_required"
    );
    await env.DB.prepare(
      `CREATE TRIGGER fail_reconnected_account_update
       BEFORE UPDATE OF status ON model_provider_accounts
       WHEN NEW.id = 'atomic-reconnect'
       BEGIN
         SELECT RAISE(ABORT, 'forced account reconnect failure');
       END`
    ).run();
    try {
      await expect(
        writer.reconnectCredentialAndAccount({
          providerAccountId: "atomic-reconnect",
          provider: "openai",
          credentialSchemaVersion: 1,
          expectedCredentialVersion: 1,
          payload: { refreshToken: "new-secret" },
          externalAccountId: "acct-atomic-reconnect",
          status: "active",
          actorId: "user-1",
          lastVerifiedAt: NOW + 1,
          now: NOW + 1,
        })
      ).rejects.toThrow(/forced account reconnect failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_reconnected_account_update").run();
    }

    await expect(
      credentials.readCredentialState("atomic-reconnect", "openai")
    ).resolves.toMatchObject({
      credentialVersion: 1,
      payload: { refreshToken: "old-secret" },
    });
    await expect(accounts.getById("atomic-reconnect")).resolves.toMatchObject({
      status: "reconnect_required",
      lastVerifiedAt: null,
    });
  });
});
