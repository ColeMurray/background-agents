import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateEncryptionKey } from "../../src/auth/crypto";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { ProviderDefaultStore } from "../../src/db/provider-account-defaults";
import { AutomationModelProviderAuthStore } from "../../src/db/automation-model-provider-auth";
import { D1ModelProviderAccountAtomicWriter } from "../../src/db/model-provider-account-atomic-writer";
import { cleanD1Tables } from "./cleanup";

const now = 1_700_000_000_000;

async function seedSession(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions
       (id, title, repo_owner, repo_name, model, status, spawn_source, spawn_depth,
        created_at, updated_at)
     VALUES (?, 'Provider test', NULL, NULL, 'openai/gpt-5', 'created', 'user', 0, ?, ?)`
  )
    .bind(id, now, now)
    .run();
}

async function seedAutomation(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, trigger_type, schedule_tz, model, enabled,
        consecutive_failures, created_by, created_at, updated_at)
     VALUES (?, 'Provider test', 'Test', 'schedule', 'UTC', 'openai/gpt-5', 1, 0,
             'test-user', ?, ?)`
  )
    .bind(id, now, now)
    .run();
}

describe("provider account migration and stores", () => {
  beforeEach(cleanD1Tables);

  it("creates all five provider-account tables", async () => {
    const result = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'model_provider_accounts',
         'model_provider_account_credentials',
         'model_provider_account_defaults',
         'session_model_provider_auth',
         'automation_model_provider_auth'
       ) ORDER BY name`
    ).all<{ name: string }>();

    expect(result.results.map((row) => row.name)).toEqual([
      "automation_model_provider_auth",
      "model_provider_account_credentials",
      "model_provider_account_defaults",
      "model_provider_accounts",
      "session_model_provider_auth",
    ]);
    const accountColumns = await env.DB.prepare("PRAGMA table_info(model_provider_accounts)").all<{
      name: string;
    }>();
    const accountColumnNames = accountColumns.results.map((column) => column.name);
    expect(accountColumnNames).not.toContain("external_account_kind");
    expect(accountColumnNames).not.toContain("provider_metadata");
    const sessionAuthColumns = await env.DB.prepare(
      "PRAGMA table_info(session_model_provider_auth)"
    ).all<{ name: string }>();
    const sessionAuthColumnNames = sessionAuthColumns.results.map((column) => column.name);
    expect(sessionAuthColumnNames).not.toContain("routing_source_type");
    expect(sessionAuthColumnNames).not.toContain("routing_source_id");
    expect(sessionAuthColumnNames).not.toContain("routing_source_revision");
  });

  it("round-trips accounts and encrypted credentials without exposing plaintext", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    const credentials = new ProviderCredentialStore(env.DB, generateEncryptionKey());
    await accounts.create({
      id: "account-1",
      provider: "openai",
      displayName: "Team ChatGPT",
      externalAccountId: "acct-1",
      now,
    });
    await credentials.create({
      providerAccountId: "account-1",
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: { refreshToken: "refresh-secret", accessToken: "access-secret" },
      accessTokenExpiresAt: now + 60_000,
      now,
    });

    expect(await accounts.getById("account-1")).toEqual(
      expect.objectContaining({
        id: "account-1",
        provider: "openai",
        displayName: "Team ChatGPT",
        status: "active",
      })
    );
    expect(await credentials.readCredentialState("account-1", "openai")).toEqual(
      expect.objectContaining({
        credentialSchemaVersion: 1,
        credentialVersion: 1,
        exchangeGeneration: 0,
        exchangeState: "idle",
        payload: { refreshToken: "refresh-secret", accessToken: "access-secret" },
      })
    );
    const raw = await env.DB.prepare(
      "SELECT encrypted_payload FROM model_provider_account_credentials WHERE provider_account_id = ?"
    )
      .bind("account-1")
      .first<{ encrypted_payload: string }>();
    expect(raw?.encrypted_payload).toMatch(/^v1\./);
    expect(raw?.encrypted_payload).not.toContain("refresh-secret");
  });

  it("rolls back account creation when the initial credential insert fails", async () => {
    const writer = new D1ModelProviderAccountAtomicWriter(env.DB, generateEncryptionKey());
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, email, created_at, updated_at)
       VALUES ('user-1', 'Test User', 'user@example.com', ?, ?)`
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER fail_initial_provider_credential
       BEFORE INSERT ON model_provider_account_credentials
       BEGIN
         SELECT RAISE(ABORT, 'forced credential failure');
       END`
    ).run();

    try {
      await expect(
        writer.createAccountWithCredential({
          id: "atomic-create",
          provider: "openai",
          displayName: "Atomic",
          externalAccountId: "acct-atomic",
          actorId: "user-1",
          now,
          credential: {
            credentialSchemaVersion: 1,
            payload: { refreshToken: "encrypted-before-batch" },
          },
        })
      ).rejects.toThrow(/forced credential failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_initial_provider_credential").run();
    }

    await expect(
      new ModelProviderAccountStore(env.DB).getById("atomic-create")
    ).resolves.toBeNull();
  });

  it("defaults only the first active account created for a provider", async () => {
    const writer = new D1ModelProviderAccountAtomicWriter(env.DB, generateEncryptionKey());
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, email, created_at, updated_at)
       VALUES ('user-1', 'Test User', 'user@example.com', ?, ?)`
    )
      .bind(now, now)
      .run();

    const first = await writer.createAccountWithCredential({
      id: "first-account",
      provider: "xai",
      displayName: "First",
      externalAccountId: "first-external",
      actorId: "user-1",
      now,
      credential: { credentialSchemaVersion: 1, payload: { refreshToken: "first" } },
    });
    const second = await writer.createAccountWithCredential({
      id: "second-account",
      provider: "xai",
      displayName: "Second",
      externalAccountId: "second-external",
      actorId: "user-1",
      now: now + 1,
      credential: { credentialSchemaVersion: 1, payload: { refreshToken: "second" } },
    });

    expect(first.id).toBe("first-account");
    expect(second.id).toBe("second-account");
    await expect(new ProviderDefaultStore(env.DB).get("xai")).resolves.toMatchObject({
      providerAccountId: "first-account",
      unattendedMode: "provider_account",
    });
  });

  it("creates one default when first accounts are connected concurrently", async () => {
    const writer = new D1ModelProviderAccountAtomicWriter(env.DB, generateEncryptionKey());
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, email, created_at, updated_at)
       VALUES ('user-1', 'Test User', 'user@example.com', ?, ?)`
    )
      .bind(now, now)
      .run();

    const created = await Promise.all(
      ["concurrent-one", "concurrent-two"].map((id) =>
        writer.createAccountWithCredential({
          id,
          provider: "xai",
          displayName: id,
          externalAccountId: `${id}-external`,
          actorId: "user-1",
          now,
          credential: { credentialSchemaVersion: 1, payload: { refreshToken: id } },
        })
      )
    );

    const providerDefault = await new ProviderDefaultStore(env.DB).get("xai");
    expect(created.map((account) => account.id)).toContain(providerDefault?.providerAccountId);
  });

  it("atomically completes verification account state and fenced credentials", async () => {
    const key = generateEncryptionKey();
    const accounts = new ModelProviderAccountStore(env.DB);
    const credentials = new ProviderCredentialStore(env.DB, key);
    const writer = new D1ModelProviderAccountAtomicWriter(env.DB, key);
    await accounts.create({
      id: "atomic-verify",
      provider: "openai",
      displayName: "Atomic verify",
      externalAccountId: "acct-verify",
      status: "reconnect_required",
      now,
    });
    await credentials.create({
      providerAccountId: "atomic-verify",
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: { refreshToken: "old-secret" },
      now,
    });
    const claim = await credentials.tryBeginExchange(
      "atomic-verify",
      1,
      "verify-owner",
      "reconnect_required",
      now + 1
    );
    expect(claim).toEqual({ acquired: true, generation: 1 });

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
          externalAccountId: "acct-verify",
          status: "active",
          actorId: "user-1",
          lastVerifiedAt: now + 2,
          now: now + 2,
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

  it("atomically reconnects credentials, identity, and status", async () => {
    const key = generateEncryptionKey();
    const accounts = new ModelProviderAccountStore(env.DB);
    const credentials = new ProviderCredentialStore(env.DB, key);
    const writer = new D1ModelProviderAccountAtomicWriter(env.DB, key);
    await accounts.create({
      id: "atomic-reconnect",
      provider: "openai",
      displayName: "Atomic reconnect",
      externalAccountId: "acct-reconnect",
      status: "reconnect_required",
      now,
    });
    await credentials.create({
      providerAccountId: "atomic-reconnect",
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: { refreshToken: "old-secret" },
      now,
    });
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
          externalAccountId: "acct-reconnect",
          status: "active",
          actorId: "user-1",
          lastVerifiedAt: now + 1,
          now: now + 1,
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

  it("enforces external identity uniqueness, provider matching, and auth-mode shape", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    await expect(
      accounts.create({
        id: "unsupported",
        provider: "other" as never,
        displayName: "Unsupported",
        now,
      })
    ).rejects.toThrow(/Unsupported model provider/);
    await accounts.create({
      id: "openai-1",
      provider: "openai",
      displayName: "OpenAI",
      externalAccountId: "external-1",
      now,
    });
    await expect(
      accounts.create({
        id: "openai-2",
        provider: "openai",
        displayName: "Duplicate",
        externalAccountId: "external-1",
        now,
      })
    ).rejects.toThrow();

    const defaults = new ProviderDefaultStore(env.DB);
    await expect(defaults.set("xai", "openai-1", "provider_account", null, now)).rejects.toThrow(
      /active xai account/i
    );
    await defaults.set("openai", "openai-1", "provider_account", null, now);
    await expect(accounts.setStatus("openai-1", "disabled", null, now)).rejects.toThrow(
      /default account must remain active/i
    );
    await expect(accounts.archive("openai-1", null, now)).rejects.toThrow(
      /default account must remain active/i
    );
    await expect(accounts.getById("openai-1")).resolves.toMatchObject({
      status: "active",
      archivedAt: null,
    });
    await expect(accounts.setStatus("openai-1", "reconnect_required", null, now)).resolves.toBe(
      true
    );
    await expect(accounts.getById("openai-1")).resolves.toMatchObject({
      status: "reconnect_required",
      archivedAt: null,
    });
    await expect(accounts.setStatus("openai-1", "active", null, now)).resolves.toBe(true);
    await defaults.remove("openai");
    await expect(accounts.setStatus("openai-1", "disabled", null, now)).resolves.toBe(true);

    await seedSession("session-1");
    await expect(
      env.DB.prepare(
        `UPDATE session_model_provider_auth
         SET auth_mode = 'api_key', provider_account_id = 'openai-1', selection_source = 'explicit'
         WHERE session_id = 'session-1' AND provider = 'openai'`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        "SELECT auth_mode FROM session_model_provider_auth WHERE session_id = 'session-1' ORDER BY provider"
      ).all()
    ).resolves.toMatchObject({
      results: [{ auth_mode: "legacy_scoped_oauth" }, { auth_mode: "legacy_scoped_oauth" }],
    });
  });

  it("coordinates credential exchange with version, owner, and generation fences", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    const credentials = new ProviderCredentialStore(env.DB, generateEncryptionKey());
    await accounts.create({
      id: "account-claim",
      provider: "xai",
      displayName: "xAI",
      now,
    });
    await credentials.create({
      providerAccountId: "account-claim",
      provider: "xai",
      credentialSchemaVersion: 1,
      payload: { refreshToken: "old" },
      now,
    });

    expect(
      await credentials.tryBeginExchange("account-claim", 1, "owner-a", "active", now + 1)
    ).toEqual({ acquired: true, generation: 1 });
    expect(
      await credentials.tryBeginExchange("account-claim", 1, "owner-b", "active", now + 2)
    ).toEqual({ acquired: false });
    expect(
      await credentials.completeExchange({
        providerAccountId: "account-claim",
        provider: "xai",
        expectedCredentialVersion: 1,
        expectedAccountStatus: "active",
        exchangeGeneration: 1,
        exchangeOwner: "wrong-owner",
        credentialSchemaVersion: 1,
        payload: { refreshToken: "wrong" },
        now: now + 3,
      })
    ).toBe(false);
    expect(
      await credentials.completeExchange({
        providerAccountId: "account-claim",
        provider: "xai",
        expectedCredentialVersion: 1,
        expectedAccountStatus: "active",
        exchangeGeneration: 1,
        exchangeOwner: "owner-a",
        credentialSchemaVersion: 1,
        payload: { refreshToken: "new" },
        accessTokenExpiresAt: now + 60_000,
        now: now + 4,
      })
    ).toBe(true);
    expect(await credentials.readCredentialState("account-claim", "xai")).toEqual(
      expect.objectContaining({
        credentialVersion: 2,
        exchangeState: "idle",
        payload: { refreshToken: "new" },
      })
    );

    expect(
      await credentials.tryBeginExchange("account-claim", 2, "owner-b", "active", now + 5)
    ).toEqual({ acquired: true, generation: 2 });
    expect(await credentials.clearSafeFailure("account-claim", 2, 2, "owner-b", now + 6)).toBe(
      true
    );
    expect(
      await credentials.tryBeginExchange("account-claim", 2, "owner-c", "active", now + 7)
    ).toEqual({ acquired: true, generation: 3 });
  });

  it("stores defaults and automation auth", async () => {
    const accounts = new ModelProviderAccountStore(env.DB);
    await accounts.create({
      id: "account-auth",
      provider: "openai",
      displayName: "OpenAI",
      now,
    });

    const defaults = new ProviderDefaultStore(env.DB);
    await defaults.set("openai", "account-auth", "api_key", null, now);
    expect(await defaults.get("openai")).toEqual(
      expect.objectContaining({
        provider: "openai",
        providerAccountId: "account-auth",
        unattendedMode: "api_key",
      })
    );

    await seedAutomation("automation-auth");
    const automationAuth = new AutomationModelProviderAuthStore(env.DB);
    await env.DB.batch(
      automationAuth.bindReplace(
        "automation-auth",
        { openai: { mode: "provider_account", accountId: "account-auth" } },
        now
      )
    );
    expect(await automationAuth.list("automation-auth")).toEqual([
      expect.objectContaining({ provider: "openai", provider_account_id: "account-auth" }),
    ]);
    await env.DB.batch(automationAuth.bindReplace("automation-auth", {}, now + 1));
    expect(await automationAuth.list("automation-auth")).toEqual([]);
  });
});
