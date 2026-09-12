import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, routeRequest, seedSandboxAuth } from "./helpers";

const ANTHROPIC_ACCOUNT_ID = "a".repeat(32);
const OPENAI_ACCOUNT_ID = "b".repeat(32);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

async function seedAnthropicAccount(now: number, expiresAt = now + YEAR_MS) {
  await env.DB.prepare(
    `INSERT INTO model_provider_accounts
      (id, provider, display_name, external_account_id, status, created_at, updated_at)
      VALUES (?, 'anthropic', 'Owner Claude', NULL, 'active', ?, ?)`
  )
    .bind(ANTHROPIC_ACCOUNT_ID, now, now)
    .run();
  await new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!).create({
    providerAccountId: ANTHROPIC_ACCOUNT_ID,
    provider: "anthropic",
    credentialSchemaVersion: 1,
    payload: {
      kind: "setup_token",
      token: "sk-ant-oat01-integration-secret",
      expiresAt,
      scopes: ["user:inference"],
    },
    accessTokenExpiresAt: expiresAt,
    now,
  });
}

function anthropicSessionAuth() {
  return [
    { provider: "openai" as const, authMode: "api_key" as const, selectionSource: "explicit" },
    { provider: "xai" as const, authMode: "api_key" as const, selectionSource: "explicit" },
    {
      provider: "anthropic" as const,
      authMode: "provider_account" as const,
      providerAccountId: ANTHROPIC_ACCOUNT_ID,
      selectionSource: "explicit",
    },
  ];
}

async function fetchRuntimeCredential(
  sessionName: string,
  token: string,
  sandboxId: string,
  provider = "anthropic"
) {
  return routeRequest(
    new Request(
      `http://localhost/sessions/${sessionName}/provider-auth/${provider}/runtime-credential`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Sandbox-ID": sandboxId,
          "Content-Type": "application/json",
        },
        body: "{}",
      }
    ),
    env,
    createExecutionContext()
  );
}

describe("stored provider secret delivery", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.exec(
      "DELETE FROM model_provider_account_defaults; DELETE FROM model_provider_account_credentials; DELETE FROM model_provider_accounts;"
    );
  });

  it("delivers the setup token to the bound sandbox", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({
      kind: "stored_provider_secret",
      secret: "sk-ant-oat01-integration-secret",
      credentialVersion: 1,
      expiresAt: expect.any(Number),
    });
  });

  it("refuses the access-token route for a stored-secret provider", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-access-token-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await routeRequest(
      new Request(`http://localhost/sessions/${sessionName}/provider-auth/anthropic/access-token`, {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token", "X-Sandbox-ID": "sandbox-1" },
      }),
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("sk-ant-oat01");
  });

  it("refuses a caller that names another sandbox", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-wrong-sandbox-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-other");

    expect(response.status).toBe(403);
  });

  it("refuses sessions that are not bound to a connected account", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-api-key-${now}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1");
    expect(response.status).toBe(404);
  });

  it("rejects brokered providers on the stored-secret route", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO model_provider_accounts
        (id, provider, display_name, external_account_id, status, created_at, updated_at)
        VALUES (?, 'openai', 'OpenAI', 'acct', 'active', ?, ?)`
    )
      .bind(OPENAI_ACCOUNT_ID, now, now)
      .run();
    const sessionName = `issuance-openai-${now}`;
    const { stub } = await initNamedSession(sessionName, {
      providerAuth: [
        {
          provider: "openai",
          authMode: "provider_account",
          providerAccountId: OPENAI_ACCOUNT_ID,
          selectionSource: "explicit",
        },
        { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
        { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
      ],
    });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(
      sessionName,
      "sandbox-token",
      "sandbox-1",
      "openai"
    );
    expect(response.status).toBe(409);
  });

  it("fences an expired token to reconnect_required", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now, now + 60_000);
    const sessionName = `issuance-expired-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1");

    expect(response.status).toBe(409);
    const account = await new ModelProviderAccountStore(env.DB).getById(ANTHROPIC_ACCOUNT_ID);
    expect(account?.status).toBe("reconnect_required");
  });

  it("fences expiry only while the inspected credential version is still current", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now, now + 60_000);
    const accounts = new ModelProviderAccountStore(env.DB);

    // A reader that inspected version 2 lost to a reconnect: nothing changes.
    expect(await accounts.requireReconnectForExpiredCredential(ANTHROPIC_ACCOUNT_ID, 2, now)).toBe(
      false
    );
    expect((await accounts.getById(ANTHROPIC_ACCOUNT_ID))?.status).toBe("active");

    expect(await accounts.requireReconnectForExpiredCredential(ANTHROPIC_ACCOUNT_ID, 1, now)).toBe(
      true
    );
    expect((await accounts.getById(ANTHROPIC_ACCOUNT_ID))?.status).toBe("reconnect_required");
  });

  it("denies a disabled account from then on", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-disable-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });
    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      200
    );

    const accounts = new ModelProviderAccountStore(env.DB);
    expect(await accounts.setStatus(ANTHROPIC_ACCOUNT_ID, "disabled", null, now + 1)).toBe(true);
    // A sandbox that already holds the token keeps it until it exits; a new
    // hand-out is refused.
    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      409
    );
  });
});
