import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, serviceFetch } from "./helpers";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { GlobalSecretsStore } from "../../src/db/global-secrets";

const OPENAI_ACCOUNT_ID = "11111111111111111111111111111111";

async function managementFetch(path: string, init?: { method?: string; body?: unknown }) {
  return serviceFetch(`https://test.local${path}`, {
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

describe("provider account management routes", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("requires a human principal and marks even auth failures private/no-store", async () => {
    const response = await SELF.fetch("https://test.local/model-provider-accounts");
    expect(response.status).toBe(401);
    expectPrivateNoStore(response);

    const serviceResponse = await serviceFetch("https://test.local/model-provider-accounts", {
      service: "linear-bot",
    });
    expect(serviceResponse.status).toBe(403);
    expectPrivateNoStore(serviceResponse);
  });

  it("does not expose a provider catalog and performs credential-free account CRUD", async () => {
    const catalog = await managementFetch("/model-subscription-providers");
    expect(catalog.status).toBe(404);

    const created = await managementFetch("/model-provider-accounts", {
      method: "POST",
      body: {
        provider: "openai",
        displayName: "Team ChatGPT",
        refreshToken: "integration-openai-refresh",
        accountId: "acct-integration",
      },
    });
    expect(created.status).toBe(201);
    expectPrivateNoStore(created);
    const createdBody = await created.json<{ account: { id: string } }>();
    expect(createdBody.account.id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(createdBody)).not.toContain("refresh");
    expect(JSON.stringify(createdBody)).not.toContain("access-token");

    const list = await managementFetch("/model-provider-accounts?provider=openai");
    expect(list.status).toBe(200);
    expectPrivateNoStore(list);
    await expect(list.json()).resolves.toMatchObject({
      accounts: [{ id: createdBody.account.id, displayName: "Team ChatGPT", status: "active" }],
    });

    const renamed = await managementFetch(`/model-provider-accounts/${createdBody.account.id}`, {
      method: "PATCH",
      body: { displayName: "Primary ChatGPT" },
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      account: { displayName: "Primary ChatGPT" },
    });

    const fetched = await managementFetch(`/model-provider-accounts/${createdBody.account.id}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      account: { displayName: "Primary ChatGPT" },
    });

    const reconnected = await managementFetch(
      `/model-provider-accounts/${createdBody.account.id}/reconnect`,
      {
        method: "POST",
        body: {
          provider: "openai",
          refreshToken: "integration-openai-refresh-reconnect",
          accountId: "acct-integration",
        },
      }
    );
    expect(reconnected.status).toBe(200);
    expectPrivateNoStore(reconnected);
    expect(JSON.stringify(await reconnected.json())).not.toContain("refresh");

    for (const action of ["disable", "enable", "verify"] as const) {
      const response = await managementFetch(
        `/model-provider-accounts/${createdBody.account.id}/${action}`,
        { method: "POST" }
      );
      expect(response.status, action).toBe(200);
      expectPrivateNoStore(response);
      expect(JSON.stringify(await response.json())).not.toContain("refresh");
    }

    const archived = await managementFetch(`/model-provider-accounts/${createdBody.account.id}`, {
      method: "DELETE",
    });
    expect(archived.status).toBe(204);
    expectPrivateNoStore(archived);
  });

  it("creates, updates, lists, and deletes provider defaults", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
        (id, provider, display_name, status, created_at, updated_at)
        VALUES (?, 'openai', 'Default OpenAI', 'active', ?, ?)`
    )
      .bind(OPENAI_ACCOUNT_ID, now, now)
      .run();

    const put = await managementFetch("/model-provider-account-defaults/openai", {
      method: "PUT",
      body: { providerAccountId: OPENAI_ACCOUNT_ID, unattendedMode: "api_key" },
    });
    expect(put.status).toBe(200);
    expectPrivateNoStore(put);
    await expect(put.json()).resolves.toMatchObject({
      default: { provider: "openai", unattendedMode: "api_key" },
    });

    const list = await managementFetch("/model-provider-account-defaults");
    await expect(list.json()).resolves.toMatchObject({ defaults: [{ provider: "openai" }] });

    const removed = await managementFetch("/model-provider-account-defaults/openai", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expectPrivateNoStore(removed);
  });

  it("preflights a duplicate identity through an atomic reconnect", async () => {
    const first = await managementFetch("/model-provider-accounts", {
      method: "POST",
      body: {
        provider: "openai",
        displayName: "Original",
        refreshToken: "integration-openai-duplicate-original",
        accountId: "acct-integration",
      },
    });
    const original = await first.json<{ account: { id: string } }>();

    const duplicate = await managementFetch("/model-provider-accounts", {
      method: "POST",
      body: {
        provider: "openai",
        displayName: "Must not create another row",
        refreshToken: "integration-openai-duplicate-reconnect",
        accountId: "acct-integration",
      },
    });

    expect(duplicate.status).toBe(200);
    const body = await duplicate.json<{
      account: { id: string; displayName: string };
      reconnectedExisting: boolean;
    }>();
    expect(body).toMatchObject({
      account: { id: original.account.id, displayName: "Original" },
      reconnectedExisting: true,
    });
    expect(JSON.stringify(body)).not.toContain("refresh");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM model_provider_accounts WHERE external_account_id = 'acct-integration'"
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it.each([
    ["missing", "22222222222222222222222222222222", 404],
    ["provider mismatch", OPENAI_ACCOUNT_ID, 400],
  ] as const)("rejects a %s default account with %i", async (kind, accountId, status) => {
    if (kind === "provider mismatch") {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO model_provider_accounts
          (id, provider, display_name, status, created_at, updated_at)
          VALUES (?, 'xai', 'xAI account', 'active', ?, ?)`
      )
        .bind(accountId, now, now)
        .run();
    }

    const response = await managementFetch("/model-provider-account-defaults/openai", {
      method: "PUT",
      body: { providerAccountId: accountId, unattendedMode: "provider_account" },
    });

    expect(response.status).toBe(status);
    expectPrivateNoStore(response);
  });

  it.each([
    ["inactive", "disabled", null],
    ["archived", "active", 1],
  ] as const)("rejects an %s default account with 409", async (_kind, status, archivedAt) => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
        (id, provider, display_name, status, created_at, updated_at, archived_at)
        VALUES (?, 'openai', 'OpenAI account', ?, ?, ?, ?)`
    )
      .bind(OPENAI_ACCOUNT_ID, status, now, now, archivedAt)
      .run();

    const response = await managementFetch("/model-provider-account-defaults/openai", {
      method: "PUT",
      body: { providerAccountId: OPENAI_ACCOUNT_ID, unattendedMode: "provider_account" },
    });

    expect(response.status).toBe(409);
    expectPrivateNoStore(response);
  });

  it("inventories legacy keys in every scope without exposing ciphertext", async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at) VALUES ('OPENAI_OAUTH_REFRESH_TOKEN', 'ciphertext', ?, ?)"
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO repo_secrets
         (repo_id, repo_owner, repo_name, key, encrypted_value, created_at, updated_at)
         VALUES (7, 'acme/platform', 'repo', 'XAI_OAUTH_ACCESS_TOKEN', 'ciphertext', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO environments (id, name, created_at, updated_at)
         VALUES ('env-1', 'Environment', ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO environment_secrets
         (environment_id, key, encrypted_value, created_at, updated_at)
         VALUES ('env-1', 'XAI_OAUTH_REFRESH_TOKEN', 'ciphertext', ?, ?)`
      ).bind(now, now),
    ]);

    const read = await managementFetch("/model-provider-accounts/legacy-credentials");
    expect(read.status).toBe(200);
    const readBody = await read.json<{ legacyKeys: unknown[] }>();
    expect(readBody.legacyKeys).toEqual([
      { scope: "environment", scopeId: "env-1", key: "XAI_OAUTH_REFRESH_TOKEN" },
      { scope: "global", key: "OPENAI_OAUTH_REFRESH_TOKEN" },
      {
        scope: "repository",
        scopeId: "7",
        repository: "acme/platform/repo",
        key: "XAI_OAUTH_ACCESS_TOKEN",
      },
    ]);
    expect(JSON.stringify(readBody)).not.toContain("ciphertext");
  });
});

describe("provider account sandbox broker route", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("is sandbox-only and applies no-store to every outcome", async () => {
    const sessionName = `provider-broker-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await env.DB.prepare(
      "DELETE FROM session_model_provider_auth WHERE session_id = ? AND provider = 'openai'"
    )
      .bind(sessionName)
      .run();
    const sandboxToken = "provider-broker-token";
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: "sandbox-1" });
    const url = `https://test.local/sessions/${sessionName}/provider-auth/openai/access-token`;

    const missing = await SELF.fetch(url, { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const service = await serviceFetch(url, { method: "POST", service: "web" });
    expect(service.status).toBe(401);
    expect(service.headers.get("Cache-Control")).toBe("no-store");

    const absentBinding = await SELF.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${sandboxToken}` },
    });
    expect(absentBinding.status).toBe(404);
    expect(absentBinding.headers.get("Cache-Control")).toBe("no-store");

    const unsupportedProvider = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/provider-auth/anthropic/access-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${sandboxToken}` },
      }
    );
    expect(unsupportedProvider.status).toBe(400);
    expect(unsupportedProvider.headers.get("Cache-Control")).toBe("no-store");
  });

  it("adapts legacy scoped OAuth to the generic provider access contract", async () => {
    const sessionName = `provider-broker-legacy-${Date.now()}`;
    await new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!).setSecrets({
      OPENAI_OAUTH_REFRESH_TOKEN: "integration-openai",
    });
    const { stub } = await initNamedSession(sessionName);
    const sandboxToken = "provider-broker-legacy-token";
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: "sandbox-legacy" });

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/provider-auth/openai/access-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${sandboxToken}` },
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      accessToken: "integration-openai-access-token",
      expiresIn: 3600,
      providerMetadata: { accountId: "acct-integration" },
    });
  });

  it("brokers only the account pinned to the trusted session auth row", async () => {
    const sessionName = `provider-broker-success-${Date.now()}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
        (id, provider, display_name, external_account_id, status, created_at, updated_at)
        VALUES (?, 'openai', 'Pinned OpenAI', 'acct-pinned', 'active', ?, ?)`
    )
      .bind(OPENAI_ACCOUNT_ID, now, now)
      .run();
    await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
      providerAccountId: OPENAI_ACCOUNT_ID,
      provider: "openai",
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "never-returned",
        accessToken: "brokered-access-token",
        accessTokenExpiresAt: now + 60 * 60 * 1000,
        accountId: "acct-pinned",
      },
      accessTokenExpiresAt: now + 60 * 60 * 1000,
      now,
    });
    const { stub } = await initNamedSession(sessionName, {
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: OPENAI_ACCOUNT_ID,
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "fallback_api_key" },
      ],
    });
    const sandboxToken = "provider-broker-success-token";
    await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId: "sandbox-success" });

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/provider-auth/openai/access-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${sandboxToken}` },
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      accessToken: "brokered-access-token",
      externalAccountId: "acct-pinned",
    });
    expect(JSON.stringify(body)).not.toContain("never-returned");
    const legacyBypass = await SELF.fetch(
      `https://test.local/sessions/${sessionName}/openai-token-refresh`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${sandboxToken}` },
      }
    );
    expect(legacyBypass.status).toBe(409);
  });
});
