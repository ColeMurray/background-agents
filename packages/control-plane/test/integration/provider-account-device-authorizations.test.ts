import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import {
  ProviderAccountAuthorizationStore,
  type ProcessingProviderAuthorization,
} from "../../src/db/provider-account-authorizations";
import { D1ModelProviderAccountAtomicWriter } from "../../src/db/model-provider-account-atomic-writer";
import { ModelProviderAccountAdapterRegistry } from "../../src/auth/model-provider-account-adapters";
import { OpenAIModelProviderAccountAdapter } from "../../src/auth/model-provider-account-openai-adapter";
import { encryptProviderAuthorizationPayload } from "../../src/auth/provider-account-crypto";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";
import { ProviderDeviceAuthorizationFinalizer } from "../../src/model-provider-accounts/device-authorization-finalizer";
import { ProviderDeviceAuthorizationService } from "../../src/model-provider-accounts/device-authorization-service";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const ACCOUNT_ID = "22".repeat(16);

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return serviceFetch(`https://test.local${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ensureAuthenticatedUser(): Promise<void> {
  const response = await request("/model-provider-accounts", "GET");
  expect(response.status).toBe(200);
}

async function start(body: unknown = { operation: "create", displayName: "Primary OpenAI" }) {
  const response = await request(
    "/model-provider-accounts/openai/device-authorizations",
    "POST",
    body
  );
  const result = await response.json<{ transactionId: string }>();
  return { response, result };
}

async function makeDue(id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE model_provider_account_authorizations SET next_poll_at = 0 WHERE id = ?"
  )
    .bind(id)
    .run();
}

async function seedAccount(externalAccountId = "acct-integration"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO model_provider_accounts
      (id, provider, display_name, external_account_id, status, created_at, updated_at)
     VALUES (?, 'openai', 'Preserved name', ?, 'reconnect_required', ?, ?)`
  )
    .bind(ACCOUNT_ID, externalAccountId, now, now)
    .run();
  await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
    providerAccountId: ACCOUNT_ID,
    provider: "openai",
    credentialSchemaVersion: 1,
    payload: { refreshToken: "old-secret" },
    now,
  });
}

describe("provider account device authorization routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("creates an account, keeps responses secret-free, and replays the connected result", async () => {
    const { response, result } = await start();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.transactionId).toMatch(/^[0-9a-f]{64}$/);

    const early = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    expect(early.status).toBe(200);
    await expect(early.json()).resolves.toMatchObject({ status: "pending" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_accounts").first<{
        count: number;
      }>()
    ).toEqual({ count: 0 });

    await makeDue(result.transactionId);
    const connected = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    expect(connected.status).toBe(200);
    const body = await connected.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: "connected",
      account: { provider: "openai", externalAccountId: "acct-integration" },
      reconnectedExisting: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/refresh|access-token|device_auth|verifier/i);

    const replay = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(replay.json()).resolves.toEqual(body);
    const transaction = await env.DB.prepare(
      "SELECT state, encrypted_provider_data FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(result.transactionId)
      .first<{ state: string; encrypted_provider_data: string | null }>();
    expect(transaction).toEqual({ state: "connected", encrypted_provider_data: null });
  });

  it("connects an xAI account through device authorization", async () => {
    const started = await request("/model-provider-accounts/xai/device-authorizations", "POST", {
      operation: "create",
      displayName: "Primary SuperGrok",
    });
    expect(started.status).toBe(201);
    const startBody = await started.json<{
      transactionId: string;
      userCode: string;
      verificationUrl: string;
    }>();
    expect(startBody).toMatchObject({
      userCode: "XAI-CODE",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=XAI-CODE",
    });

    await makeDue(startBody.transactionId);
    const connected = await request(
      `/model-provider-accounts/xai/device-authorizations/${startBody.transactionId}/poll`,
      "POST"
    );
    const connectedBody = await connected.json<{ account: { id: string } }>();
    expect(connectedBody).toMatchObject({
      status: "connected",
      account: {
        provider: "xai",
        displayName: "Primary SuperGrok",
        externalAccountId: "xai-integration",
      },
      reconnectedExisting: false,
    });

    const legacyReconnect = await request(
      `/model-provider-accounts/${connectedBody.account.id}/reconnect`,
      "POST",
      { provider: "xai", refreshToken: "integration-xai-manual-reconnect" }
    );
    expect(legacyReconnect.status).toBe(409);
    await expect(legacyReconnect.json()).resolves.toMatchObject({
      error: "Identity-bound xAI accounts must reconnect through device authorization",
    });
  });

  it("reconnects only the same trusted identity and preserves the display name", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    await makeDue(result.transactionId);
    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "connected",
      account: { id: ACCOUNT_ID, displayName: "Preserved name", status: "active" },
      reconnectedExisting: true,
    });
  });

  it("converges duplicate creates on the trusted external identity", async () => {
    const first = await start({ operation: "create", displayName: "Original name" });
    await makeDue(first.result.transactionId);
    const firstPoll = await request(
      `/model-provider-accounts/openai/device-authorizations/${first.result.transactionId}/poll`,
      "POST"
    );
    const firstBody = await firstPoll.json<{ account: { id: string } }>();

    const duplicate = await start({ operation: "create", displayName: "Must not replace name" });
    await makeDue(duplicate.result.transactionId);
    const duplicatePoll = await request(
      `/model-provider-accounts/openai/device-authorizations/${duplicate.result.transactionId}/poll`,
      "POST"
    );
    await expect(duplicatePoll.json()).resolves.toMatchObject({
      status: "connected",
      account: { id: firstBody.account.id, displayName: "Original name" },
      reconnectedExisting: true,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_accounts").first<{
        count: number;
      }>()
    ).toEqual({ count: 1 });
  });

  it("allows only one processing claim across concurrent polls", async () => {
    const { result } = await start();
    await makeDue(result.transactionId);
    const path = `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`;
    const responses = await Promise.all([request(path, "POST"), request(path, "POST")]);
    const bodies = await Promise.all(
      responses.map((response) => response.json<{ status: string }>())
    );
    expect(bodies.map((body) => body.status)).toContain("connected");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_accounts").first<{
        count: number;
      }>()
    ).toEqual({ count: 1 });
    const row = await env.DB.prepare(
      "SELECT state, processing_owner FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(result.transactionId)
      .first<{ state: string; processing_owner: string | null }>();
    expect(row).toEqual({ state: "connected", processing_owner: null });
  });

  it("fails closed on reconnect identity mismatch", async () => {
    await ensureAuthenticatedUser();
    await seedAccount("acct-other");
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    await makeDue(result.transactionId);
    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      status: "failed",
      retryable: true,
    });
    const row = await env.DB.prepare(
      "SELECT state, encrypted_provider_data FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(result.transactionId)
      .first<{ state: string; encrypted_provider_data: string | null }>();
    expect(row).toEqual({ state: "failed", encrypted_provider_data: null });
  });

  it("binds cancellation to the owner and prevents completion", async () => {
    const { result } = await start();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at)
       VALUES ('other-user', 'Other', 'other@test.local', 1, ?, ?)`
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "UPDATE model_provider_account_authorizations SET user_id = 'other-user' WHERE id = ?"
    )
      .bind(result.transactionId)
      .run();
    const notOwner = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}`,
      "DELETE"
    );
    expect(notOwner.status).toBe(404);

    await env.DB.prepare(
      "UPDATE model_provider_account_authorizations SET user_id = ? WHERE id = ?"
    )
      .bind("11111111111111111111111111111111", result.transactionId)
      .run();
    const cancelled = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}`,
      "DELETE"
    );
    expect(cancelled.status).toBe(204);
    await makeDue(result.transactionId);
    const poll = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(poll.json()).resolves.toMatchObject({ status: "cancelled" });
  });

  it("supersedes older creates and cancellation does not refund the rolling rate budget", async () => {
    const first = await start();
    const second = await start();
    const firstRow = await env.DB.prepare(
      "SELECT state FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(first.result.transactionId)
      .first<{ state: string }>();
    expect(firstRow?.state).toBe("superseded");

    await request(
      `/model-provider-accounts/openai/device-authorizations/${second.result.transactionId}`,
      "DELETE"
    );
    await start();
    await start();
    await start();
    const limited = await start();
    expect(limited.response.status).toBe(429);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM model_provider_account_authorization_attempts"
      ).first<{ count: number }>()
    ).toEqual({ count: 5 });
  });

  it("expires locally without allowing a provider completion", async () => {
    const { result } = await start();
    const expiredAt = Date.now() - 1;
    await env.DB.prepare(
      `UPDATE model_provider_account_authorizations
       SET created_at = ?, expires_at = ? WHERE id = ?`
    )
      .bind(expiredAt - 1, expiredAt, result.transactionId)
      .run();
    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(response.json()).resolves.toMatchObject({ status: "expired" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_accounts").first<{
        count: number;
      }>()
    ).toEqual({ count: 0 });
  });

  it("durably expires and clears provider state when polling crosses expiry", async () => {
    await ensureAuthenticatedUser();
    let now = 100_000;
    let sequence = 0;
    const adapter = new OpenAIModelProviderAccountAdapter(undefined, {
      stateSchemaVersion: 1,
      start: async () => ({
        providerState: { deviceAuthId: "device", userCode: "CODE" },
        userCode: "CODE",
        verificationUrl: "https://provider.test/device",
        intervalMs: 1_000,
        expiresInMs: 2_000,
      }),
      parseState: (state: unknown) => state,
      poll: async () => {
        now = 102_001;
        return { status: "pending" as const };
      },
    });
    const accounts = new ModelProviderAccountStore(env.DB);
    const service = new ProviderDeviceAuthorizationService(
      new ProviderAccountAuthorizationStore(env.DB),
      accounts,
      new ProviderDeviceAuthorizationFinalizer(
        accounts,
        new D1ModelProviderAccountAtomicWriter(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!),
        () => (++sequence).toString(16).padStart(32, "0")
      ),
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!,
      new ModelProviderAccountAdapterRegistry([adapter]),
      {
        generateId: (bytes) => (++sequence).toString(16).padStart(bytes * 2, "0"),
        now: () => now,
      },
      { error: () => undefined }
    );
    const started = await service.start("11111111111111111111111111111111", "openai", {
      operation: "create",
      displayName: "Crossing expiry",
    });
    await makeDue(started.transactionId);
    now = 101_500;

    const initial = await service.poll(
      "11111111111111111111111111111111",
      "openai",
      started.transactionId
    );
    expect(initial).toMatchObject({ status: "expired", retryable: true });
    const replay = await service.poll(
      "11111111111111111111111111111111",
      "openai",
      started.transactionId
    );
    expect(replay).toEqual(initial);
    const transaction = await env.DB.prepare(
      `SELECT state, encrypted_provider_data, provider_state_version
       FROM model_provider_account_authorizations WHERE id = ?`
    )
      .bind(started.transactionId)
      .first<{
        state: string;
        encrypted_provider_data: string | null;
        provider_state_version: number | null;
      }>();
    expect(transaction).toEqual({
      state: "expired",
      encrypted_provider_data: null,
      provider_state_version: null,
    });
  });

  it.each([
    ["invalid state", 1, { deviceAuthId: "device" }],
    ["unsupported state version", 2, { deviceAuthId: "device", userCode: "CODE" }],
  ])(
    "fails and clears %s before returning a replayable terminal result",
    async (_, version, state) => {
      const { result } = await start();
      const encrypted = await encryptProviderAuthorizationPayload(
        state,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!,
        { transactionId: result.transactionId, provider: "openai", stateSchemaVersion: version }
      );
      await env.DB.prepare(
        `UPDATE model_provider_account_authorizations
       SET encrypted_provider_data = ?, provider_state_version = ?, next_poll_at = 0
       WHERE id = ?`
      )
        .bind(encrypted, version, result.transactionId)
        .run();

      const path = `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`;
      const response = await request(path, "POST");
      const initial = await response.json();
      expect(initial).toMatchObject({ status: "failed", retryable: true });
      const replay = await request(path, "POST");
      await expect(replay.json()).resolves.toEqual(initial);
      const transaction = await env.DB.prepare(
        `SELECT state, encrypted_provider_data, provider_state_version
       FROM model_provider_account_authorizations WHERE id = ?`
      )
        .bind(result.transactionId)
        .first();
      expect(transaction).toEqual({
        state: "failed",
        encrypted_provider_data: null,
        provider_state_version: null,
      });
    }
  );

  it("does not replace credentials or connect when an account is archived before finalization", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    const owner = "race-owner";
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE model_provider_account_authorizations
       SET state = 'processing', processing_owner = ?, processing_started_at = ?, next_poll_at = 0
       WHERE id = ?`
    )
      .bind(owner, now, result.transactionId)
      .run();
    const transaction = await new ProviderAccountAuthorizationStore(env.DB).getOwned(
      "11111111111111111111111111111111",
      result.transactionId
    );
    expect(transaction?.state).toBe("processing");
    let injected = false;
    const racingDb: SqlDatabase = {
      prepare: (query: string) => env.DB.prepare(query) as SqlStatement,
      batch: async <_T>(statements: SqlStatement[]) => {
        if (!injected) {
          injected = true;
          await env.DB.prepare(
            "UPDATE model_provider_accounts SET archived_at = ?, updated_at = ? WHERE id = ?"
          )
            .bind(now + 1, now + 1, ACCOUNT_ID)
            .run();
        }
        return env.DB.batch(statements as D1PreparedStatement[]) as ReturnType<
          SqlDatabase["batch"]
        >;
      },
    };
    const finalizer = new ProviderDeviceAuthorizationFinalizer(
      new ModelProviderAccountStore(env.DB),
      new D1ModelProviderAccountAtomicWriter(racingDb, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!),
      () => "33".repeat(16)
    );

    await expect(
      finalizer.finalizeTrustedConnection(
        transaction as ProcessingProviderAuthorization,
        {
          credential: { refreshToken: "new-secret" },
          externalAccountId: "acct-integration",
        },
        new OpenAIModelProviderAccountAdapter(),
        now
      )
    ).resolves.toBe(false);
    const credential = await new ProviderCredentialStore(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    ).readCredentialState<{ refreshToken: string }>(ACCOUNT_ID, "openai");
    expect(credential?.payload.refreshToken).toBe("old-secret");
    expect(credential?.credentialVersion).toBe(1);
    const durable = await env.DB.prepare(
      "SELECT state, result_provider_account_id FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(result.transactionId)
      .first();
    expect(durable).toEqual({ state: "processing", result_provider_account_id: null });
  });

  it("does not reconnect an account disabled while authorization is pending", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    await new ModelProviderAccountStore(env.DB).setStatus(ACCOUNT_ID, "disabled", null, Date.now());
    await makeDue(result.transactionId);

    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(response.json()).resolves.toMatchObject({ status: "failed", retryable: true });
    const credential = await new ProviderCredentialStore(
      env.DB,
      env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
    ).readCredentialState<{ refreshToken: string }>(ACCOUNT_ID, "openai");
    expect(credential?.payload.refreshToken).toBe("old-secret");
    expect(credential?.credentialVersion).toBe(1);
  });

  it("leaves account, credential, and authorization rows unchanged when finalization is rejected", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    const owner = "stale-target-owner";
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE model_provider_account_authorizations
       SET state = 'processing', processing_owner = ?, processing_started_at = ?
       WHERE id = ?`
    )
      .bind(owner, now, result.transactionId)
      .run();
    const authorizations = new ProviderAccountAuthorizationStore(env.DB);
    const transaction = await authorizations.getOwned(
      "11111111111111111111111111111111",
      result.transactionId
    );
    expect(transaction?.state).toBe("processing");

    // Invalidate the target fence before the writer begins. The rejected call
    // itself must not partially mutate any of its three persistence rows.
    await new ModelProviderAccountStore(env.DB).setStatus(ACCOUNT_ID, "disabled", null, now + 1);
    const readRows = () =>
      Promise.all([
        env.DB.prepare("SELECT * FROM model_provider_accounts WHERE id = ?")
          .bind(ACCOUNT_ID)
          .first(),
        env.DB.prepare(
          "SELECT * FROM model_provider_account_credentials WHERE provider_account_id = ?"
        )
          .bind(ACCOUNT_ID)
          .first(),
        env.DB.prepare("SELECT * FROM model_provider_account_authorizations WHERE id = ?")
          .bind(result.transactionId)
          .first(),
      ]);
    const before = await readRows();

    await expect(
      new D1ModelProviderAccountAtomicWriter(
        env.DB,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
      ).finalizeDeviceAuthorizationReconnect({
        authorization: transaction as ProcessingProviderAuthorization,
        accountId: ACCOUNT_ID,
        externalAccountId: "acct-integration",
        credential: { refreshToken: "new-secret" },
        credentialSchemaVersion: 1,
        accessTokenExpiresAt: null,
        now: now + 2,
      })
    ).resolves.toEqual({ type: "target_changed" });
    await expect(readRows()).resolves.toEqual(before);
  });

  it("reconnects an account that was already disabled when authorization started", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    await new ModelProviderAccountStore(env.DB).setStatus(ACCOUNT_ID, "disabled", null, Date.now());
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    await makeDue(result.transactionId);

    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "connected",
      account: { id: ACCOUNT_ID, status: "active" },
    });
  });

  it("does not replace credentials when a disabled reconnect target is concurrently enabled", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const accounts = new ModelProviderAccountStore(env.DB);
    await accounts.setStatus(ACCOUNT_ID, "disabled", null, Date.now());
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    const owner = "enable-race-owner";
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE model_provider_account_authorizations
       SET state = 'processing', processing_owner = ?, processing_started_at = ?, next_poll_at = 0
       WHERE id = ?`
    )
      .bind(owner, now, result.transactionId)
      .run();
    const transaction = await new ProviderAccountAuthorizationStore(env.DB).getOwned(
      "11111111111111111111111111111111",
      result.transactionId
    );
    expect(transaction?.state).toBe("processing");

    let injected = false;
    const racingDb: SqlDatabase = {
      prepare: (query: string) => env.DB.prepare(query) as SqlStatement,
      batch: async <_T>(statements: SqlStatement[]) => {
        if (!injected) {
          injected = true;
          await accounts.setStatus(ACCOUNT_ID, "active", null, now + 1);
        }
        return env.DB.batch(statements as D1PreparedStatement[]) as ReturnType<
          SqlDatabase["batch"]
        >;
      },
    };
    const credentials = new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
    const finalizer = new ProviderDeviceAuthorizationFinalizer(
      accounts,
      new D1ModelProviderAccountAtomicWriter(racingDb, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!),
      () => "33".repeat(16)
    );

    await expect(
      finalizer.finalizeTrustedConnection(
        transaction as ProcessingProviderAuthorization,
        {
          credential: { refreshToken: "new-secret" },
          externalAccountId: "acct-integration",
        },
        new OpenAIModelProviderAccountAdapter(),
        now
      )
    ).resolves.toBe(false);
    expect((await accounts.getLifecycleSnapshot(ACCOUNT_ID))?.account.status).toBe("active");
    const credential = await credentials.readCredentialState<{ refreshToken: string }>(
      ACCOUNT_ID,
      "openai"
    );
    expect(credential?.payload.refreshToken).toBe("old-secret");
    expect(credential?.credentialVersion).toBe(1);
    const durable = await env.DB.prepare(
      "SELECT state, result_provider_account_id FROM model_provider_account_authorizations WHERE id = ?"
    )
      .bind(result.transactionId)
      .first();
    expect(durable).toEqual({ state: "processing", result_provider_account_id: null });
  });

  it("reconnects after last-used and display-name updates without changing the lifecycle fence", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const accounts = new ModelProviderAccountStore(env.DB);
    const before = await accounts.getLifecycleSnapshot(ACCOUNT_ID);
    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });

    await accounts.touchLastUsed(ACCOUNT_ID, Date.now() + 1, Date.now() + 10_000);
    await accounts.updateDetails(ACCOUNT_ID, {
      displayName: "Renamed while pending",
      now: Date.now() + 20_000,
    });
    const afterMetadataUpdates = await accounts.getLifecycleSnapshot(ACCOUNT_ID);
    expect(afterMetadataUpdates?.lifecycleVersion).toBe(before?.lifecycleVersion);
    expect(afterMetadataUpdates?.account.updatedAt).not.toBe(before?.account.updatedAt);
    await makeDue(result.transactionId);

    const response = await request(
      `/model-provider-accounts/openai/device-authorizations/${result.transactionId}/poll`,
      "POST"
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "connected",
      account: { id: ACCOUNT_ID, displayName: "Renamed while pending", status: "active" },
    });
    const connected = await accounts.getLifecycleSnapshot(ACCOUNT_ID);
    expect(connected?.lifecycleVersion).toBe((before?.lifecycleVersion ?? -1) + 1);
  });
});
