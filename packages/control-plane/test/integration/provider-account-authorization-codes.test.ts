import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import {
  AnthropicModelProviderAccountAdapter,
  type AnthropicProviderCredential,
} from "../../src/auth/model-provider-account-anthropic-adapter";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const ACCOUNT_ID = "44".repeat(16);
const USER_ID = "11111111111111111111111111111111";
const BASE = "/model-provider-accounts/anthropic/authorization-codes";
/** What the integration outbound stub accepts, rejects, and cannot reach. */
const GOOD_CODE = "integration-anthropic-code";
const BAD_CODE = "integration-anthropic-unknown";
const OUTAGE_CODE = "integration-anthropic-outage";
const THROTTLED_CODE = "integration-anthropic-throttled";

interface AuthorizationRow {
  state: string;
  authorization_kind: string;
  encrypted_provider_data: string | null;
  next_poll_at: number;
  processing_owner: string | null;
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return serviceFetch(`https://test.local${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ensureAuthenticatedUser(): Promise<void> {
  expect((await request("/model-provider-accounts", "GET")).status).toBe(200);
}

async function start(body: unknown = { operation: "create", displayName: "Primary Claude" }) {
  const response = await request(BASE, "POST", body);
  const result = await response.json<{ transactionId: string; authorizationUrl: string }>();
  return { response, result };
}

async function complete(id: string, code: string): Promise<Response> {
  return request(`${BASE}/${id}/complete`, "POST", { code });
}

async function authorizationRow(id: string): Promise<AuthorizationRow | null> {
  return env.DB.prepare(
    `SELECT state, authorization_kind, encrypted_provider_data, next_poll_at, processing_owner
     FROM model_provider_account_authorizations WHERE id = ?`
  )
    .bind(id)
    .first<AuthorizationRow>();
}

async function accountCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_accounts").first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

function credentials(): ProviderCredentialStore {
  return new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
}

function parseAnthropicCredential(
  state: NonNullable<Awaited<ReturnType<ProviderCredentialStore["readCredentialState"]>>>
) {
  return new AnthropicModelProviderAccountAdapter().parseCredential(
    state.payload,
    state.credentialSchemaVersion
  );
}

async function seedAccount(status = "reconnect_required"): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO model_provider_accounts
      (id, provider, display_name, external_account_id, status, created_at, updated_at)
     VALUES (?, 'anthropic', 'Preserved Claude', NULL, ?, ?, ?)`
  )
    .bind(ACCOUNT_ID, status, now, now)
    .run();
  await credentials().create({
    providerAccountId: ACCOUNT_ID,
    provider: "anthropic",
    credentialSchemaVersion: 1,
    payload: {
      kind: "setup_token",
      token: "sk-ant-oat01-old",
      expiresAt: now + 1_000,
      scopes: ["user:inference"],
    } satisfies AnthropicProviderCredential,
    now,
  });
}

describe("provider account authorization-code routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("starts a paste-back authorization that reports pending until completed", async () => {
    const before = Date.now();
    const { response, result } = await start();
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.transactionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ provider: "anthropic", operation: "create" });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("scope")).toBe("user:inference");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(JSON.stringify(result)).not.toMatch(/verifier/i);

    const row = await authorizationRow(result.transactionId);
    expect(row).toMatchObject({ state: "pending", authorization_kind: "authorization_code" });
    expect(row!.next_poll_at).toBeLessThanOrEqual(Date.now());
    expect(row!.next_poll_at).toBeGreaterThanOrEqual(before);

    const status = await request(`${BASE}/${result.transactionId}`, "GET");
    expect(status.status).toBe(200);
    expect(status.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(status.json()).resolves.toEqual({
      status: "pending",
      expiresAt: expect.any(Number),
    });
    expect(await accountCount()).toBe(0);
  });

  it("creates an account named by the granting Claude account and replays the result", async () => {
    const { result } = await start();

    const connected = await complete(result.transactionId, GOOD_CODE);
    expect(connected.status).toBe(200);
    const body = await connected.json<{ account: { id: string } }>();
    expect(body).toMatchObject({
      status: "connected",
      account: {
        provider: "anthropic",
        displayName: "Primary Claude",
        externalAccountId: "integration-anthropic-account",
        status: "active",
      },
      reconnectedExisting: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|refresh|verifier/i);

    const stored = await credentials().readCredentialState(body.account.id, "anthropic");
    expect(stored?.payload).toEqual({
      kind: "setup_token",
      token: "sk-ant-oat01-integration",
      expiresAt: expect.any(Number),
      scopes: ["user:inference"],
      tokenUuid: "integration-anthropic-token-uuid",
      organizationName: "Integration Org",
    });
    expect(stored?.credentialVersion).toBe(1);
    expect(JSON.stringify(stored?.payload)).not.toContain("must-not-persist");
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "connected",
      encrypted_provider_data: null,
      processing_owner: null,
    });
    await expect(
      env.DB.prepare(
        "SELECT provider_account_id, unattended_mode FROM model_provider_account_defaults WHERE provider = 'anthropic'"
      ).first()
    ).resolves.toEqual({
      provider_account_id: body.account.id,
      unattended_mode: "provider_account",
    });

    const replay = await complete(result.transactionId, "anything-else");
    await expect(replay.json()).resolves.toEqual(body);
    const status = await request(`${BASE}/${result.transactionId}`, "GET");
    await expect(status.json()).resolves.toEqual(body);
    expect(
      (await credentials().readCredentialState(body.account.id, "anthropic"))?.credentialVersion
    ).toBe(1);
  });

  it("converges a second create for the same Claude account onto the existing slot", async () => {
    const first = await start({ operation: "create", displayName: "Work Claude" });
    await complete(first.result.transactionId, GOOD_CODE);
    const second = await start({ operation: "create", displayName: "Personal Claude" });
    const response = await complete(second.result.transactionId, GOOD_CODE);
    await expect(response.json()).resolves.toMatchObject({
      status: "connected",
      account: { displayName: "Work Claude", externalAccountId: "integration-anthropic-account" },
      reconnectedExisting: true,
    });
    expect(await accountCount()).toBe(1);
  });

  it("denies a rejected code and never exchanges it again", async () => {
    const { result } = await start();

    const denied = await complete(result.transactionId, BAD_CODE);
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toEqual({
      status: "denied",
      error: "Unknown integration code",
      retryable: false,
    });
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "denied",
      encrypted_provider_data: null,
    });

    const replay = await complete(result.transactionId, GOOD_CODE);
    await expect(replay.json()).resolves.toMatchObject({ status: "denied", retryable: false });
    expect(await accountCount()).toBe(0);
  });

  it("denies a code pasted with another attempt's state before contacting the provider", async () => {
    const { result } = await start();
    const denied = await complete(result.transactionId, `${GOOD_CODE}#not-this-attempt`);
    await expect(denied.json()).resolves.toMatchObject({
      status: "denied",
      error: expect.stringMatching(/different authorization attempt/),
      retryable: false,
    });
    expect(await accountCount()).toBe(0);
  });

  it("fails closed when the provider cannot be reached, since the code may be spent", async () => {
    const { result } = await start();

    const response = await complete(result.transactionId, OUTAGE_CODE);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "failed",
      error: expect.stringMatching(/may already have been used/),
      retryable: true,
    });
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "failed",
      encrypted_provider_data: null,
    });
    // The same code is never sent again.
    const replay = await complete(result.transactionId, GOOD_CODE);
    await expect(replay.json()).resolves.toMatchObject({ status: "failed" });
    expect(await accountCount()).toBe(0);
  });

  it("returns to pending when the provider throttles, then fails after three attempts", async () => {
    const { result } = await start();
    const before = await authorizationRow(result.transactionId);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await complete(result.transactionId, THROTTLED_CODE);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ retryable: true });
      const row = await authorizationRow(result.transactionId);
      expect(row).toMatchObject({ state: "pending", processing_owner: null });
      expect(row!.encrypted_provider_data).not.toBe(before!.encrypted_provider_data);
      const status = await request(`${BASE}/${result.transactionId}`, "GET");
      await expect(status.json()).resolves.toMatchObject({ status: "pending" });
    }

    const exhausted = await complete(result.transactionId, THROTTLED_CODE);
    expect(exhausted.status).toBe(200);
    await expect(exhausted.json()).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "failed",
      encrypted_provider_data: null,
    });
    expect(await accountCount()).toBe(0);
  });

  it("reconnects the targeted account and preserves its name", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const { response, result } = await start({
      operation: "reconnect",
      providerAccountId: ACCOUNT_ID,
    });
    expect(response.status).toBe(201);

    const connected = await complete(result.transactionId, GOOD_CODE);
    await expect(connected.json()).resolves.toMatchObject({
      status: "connected",
      account: { id: ACCOUNT_ID, displayName: "Preserved Claude", status: "active" },
      reconnectedExisting: true,
    });
    const stored = await credentials().readCredentialState(ACCOUNT_ID, "anthropic");
    expect(stored ? parseAnthropicCredential(stored).token : undefined).toBe(
      "sk-ant-oat01-integration"
    );
    expect(stored?.credentialVersion).toBe(2);
    expect(await accountCount()).toBe(1);
    // A slot created without an identity (pasted token) adopts the one the
    // browser flow names, so it now converges and verifies like any other.
    await expect(
      env.DB.prepare("SELECT external_account_id FROM model_provider_accounts WHERE id = ?")
        .bind(ACCOUNT_ID)
        .first()
    ).resolves.toEqual({ external_account_id: "integration-anthropic-account" });
  });

  it("refuses a browser reconnect whose Claude account already has another slot", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const created = await start({ operation: "create", displayName: "Browser Claude" });
    await complete(created.result.transactionId, GOOD_CODE);
    expect(await accountCount()).toBe(2);

    const { result } = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    const response = await complete(result.transactionId, GOOD_CODE);
    await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    await expect(
      env.DB.prepare("SELECT external_account_id, status FROM model_provider_accounts WHERE id = ?")
        .bind(ACCOUNT_ID)
        .first()
    ).resolves.toEqual({ external_account_id: null, status: "reconnect_required" });
    expect(
      (await credentials().readCredentialState(ACCOUNT_ID, "anthropic"))?.credentialVersion
    ).toBe(1);
  });

  it("refuses a pasted setup token on an account the browser flow named", async () => {
    const { result } = await start();
    const connected = await complete(result.transactionId, GOOD_CODE);
    const { account } = await connected.json<{ account: { id: string } }>();

    const response = await request(`/model-provider-accounts/${account.id}/reconnect`, "POST", {
      provider: "anthropic",
      setupToken: "sk-ant-oat01-pasted-elsewhere",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/connected through the browser/),
    });
    const stored = await credentials().readCredentialState(account.id, "anthropic");
    expect(stored ? parseAnthropicCredential(stored).token : undefined).toBe(
      "sk-ant-oat01-integration"
    );
    expect(stored?.credentialVersion).toBe(1);
  });

  it("refuses reconnect targets that belong to another provider or are archived", async () => {
    await ensureAuthenticatedUser();
    await seedAccount();
    const wrongProvider = await request(
      "/model-provider-accounts/openai/authorization-codes",
      "POST",
      { operation: "reconnect", providerAccountId: ACCOUNT_ID }
    );
    // OpenAI has no authorization-code capability; the provider check comes first.
    expect(wrongProvider.status).toBe(409);

    await env.DB.prepare("UPDATE model_provider_accounts SET archived_at = ? WHERE id = ?")
      .bind(Date.now(), ACCOUNT_ID)
      .run();
    const archived = await start({ operation: "reconnect", providerAccountId: ACCOUNT_ID });
    expect(archived.response.status).toBe(409);
  });

  it("refuses device authorization for Anthropic and authorization codes for OpenAI", async () => {
    const device = await request(
      "/model-provider-accounts/anthropic/device-authorizations",
      "POST",
      {
        operation: "create",
        displayName: "Claude",
      }
    );
    expect(device.status).toBe(409);
    const code = await request("/model-provider-accounts/openai/authorization-codes", "POST", {
      operation: "create",
      displayName: "OpenAI",
    });
    expect(code.status).toBe(409);
  });

  it("binds cancellation to the owner and prevents completion", async () => {
    const { result } = await start();
    const notFound = await request(`${BASE}/${"0".repeat(64)}`, "DELETE");
    expect(notFound.status).toBe(404);

    const cancelled = await request(`${BASE}/${result.transactionId}`, "DELETE");
    expect(cancelled.status).toBe(204);
    const response = await complete(result.transactionId, GOOD_CODE);
    await expect(response.json()).resolves.toMatchObject({ status: "cancelled" });
    expect(await accountCount()).toBe(0);
  });

  it("expires locally without exchanging the code", async () => {
    const { result } = await start();
    const expiredAt = Date.now() - 1;
    await env.DB.prepare(
      "UPDATE model_provider_account_authorizations SET created_at = ?, expires_at = ? WHERE id = ?"
    )
      .bind(expiredAt - 1, expiredAt, result.transactionId)
      .run();

    const response = await complete(result.transactionId, GOOD_CODE);
    await expect(response.json()).resolves.toMatchObject({ status: "expired" });
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "expired",
      encrypted_provider_data: null,
    });
    expect(await accountCount()).toBe(0);
  });

  it("validates the pasted code body and the transaction id", async () => {
    const { result } = await start();
    const empty = await request(`${BASE}/${result.transactionId}/complete`, "POST", { code: "" });
    expect(empty.status).toBe(400);
    const unknown = await complete("not-a-transaction", GOOD_CODE);
    expect(unknown.status).toBe(404);
    expect(await authorizationRow(result.transactionId)).toMatchObject({ state: "pending" });
  });

  it("refuses to verify a connected Anthropic account against the provider", async () => {
    await ensureAuthenticatedUser();
    await seedAccount("active");
    const response = await request(`/model-provider-accounts/${ACCOUNT_ID}/verify`, "POST");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/cannot be verified/),
    });
    expect((await credentials().readCredentialState(ACCOUNT_ID, "anthropic"))?.exchangeState).toBe(
      "idle"
    );
  });

  it("keeps each completion kind to its own routes under the same provider", async () => {
    const device = await request("/model-provider-accounts/openai/device-authorizations", "POST", {
      operation: "create",
      displayName: "Primary OpenAI",
    });
    const { transactionId: deviceId } = await device.json<{ transactionId: string }>();
    expect(await authorizationRow(deviceId)).toMatchObject({
      state: "pending",
      authorization_kind: "device",
    });
    const codeRoutes = `/model-provider-accounts/openai/authorization-codes/${deviceId}`;
    expect((await request(codeRoutes, "GET")).status).toBe(404);
    expect((await request(`${codeRoutes}/complete`, "POST", { code: GOOD_CODE })).status).toBe(404);
    expect((await request(codeRoutes, "DELETE")).status).toBe(404);
    expect(await authorizationRow(deviceId)).toMatchObject({
      state: "pending",
      processing_owner: null,
    });

    const { result } = await start();
    const deviceRoutes = `/model-provider-accounts/anthropic/device-authorizations/${result.transactionId}`;
    expect((await request(deviceRoutes, "GET")).status).toBe(404);
    expect((await request(deviceRoutes, "DELETE")).status).toBe(404);
    expect(await authorizationRow(result.transactionId)).toMatchObject({
      state: "pending",
      authorization_kind: "authorization_code",
      processing_owner: null,
    });
  });

  it("reports another user's transaction as missing", async () => {
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
    expect((await request(`${BASE}/${result.transactionId}`, "GET")).status).toBe(404);
    expect((await complete(result.transactionId, GOOD_CODE)).status).toBe(404);
    await env.DB.prepare(
      "UPDATE model_provider_account_authorizations SET user_id = ? WHERE id = ?"
    )
      .bind(USER_ID, result.transactionId)
      .run();
    expect((await request(`${BASE}/${result.transactionId}`, "GET")).status).toBe(200);
  });
});
