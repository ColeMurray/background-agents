import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import {
  ProviderAccountCleanupOutboxStore,
  ProviderCredentialIssuanceStore,
} from "../../src/db/provider-credential-issuances";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialCleanupCoordinator } from "../../src/model-provider-accounts/credential-cleanup";
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
      "DELETE FROM model_provider_account_cleanup_outbox; DELETE FROM model_provider_credential_issuances; DELETE FROM model_provider_account_defaults; DELETE FROM model_provider_account_credentials; DELETE FROM model_provider_accounts;"
    );
  });

  it("delivers the setup token to the bound sandbox and records the issuance", async () => {
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
    const issuances = await new ProviderCredentialIssuanceStore(env.DB).listForSession(sessionName);
    expect(issuances).toHaveLength(1);
    expect(issuances[0]).toMatchObject({
      providerAccountId: ANTHROPIC_ACCOUNT_ID,
      sandboxId: "sandbox-1",
      credentialVersion: 1,
      terminatedAt: null,
    });
  });

  it("keeps one issuance row per sandbox however often it asks", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-repeat-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      200
    );
    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      200
    );

    const issuances = await new ProviderCredentialIssuanceStore(env.DB).listForSession(sessionName);
    expect(issuances).toHaveLength(1);
  });

  it("keeps the issuance as revocation evidence after the session row is deleted", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-deleted-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });
    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      200
    );

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionName).run();

    const live = await new ProviderCredentialIssuanceStore(env.DB).listLive(
      ANTHROPIC_ACCOUNT_ID,
      1
    );
    expect(live.map((row) => row.sessionId)).toEqual([sessionName]);
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
    expect(await new ProviderCredentialIssuanceStore(env.DB).listForSession(sessionName)).toEqual(
      []
    );
  });

  it("refuses a caller that names another sandbox", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now);
    const sessionName = `issuance-wrong-sandbox-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-other");

    expect(response.status).toBe(403);
    expect(await new ProviderCredentialIssuanceStore(env.DB).listForSession(sessionName)).toEqual(
      []
    );
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

  it("fences an expired token to reconnect_required and enqueues cleanup", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now, now + 60_000);
    const sessionName = `issuance-expired-${now}`;
    const { stub } = await initNamedSession(sessionName, { providerAuth: anthropicSessionAuth() });
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1");

    expect(response.status).toBe(409);
    const account = await new ModelProviderAccountStore(env.DB).getById(ANTHROPIC_ACCOUNT_ID);
    expect(account?.status).toBe("reconnect_required");
    const outbox = await new ProviderAccountCleanupOutboxStore(env.DB).listForAccount(
      ANTHROPIC_ACCOUNT_ID
    );
    expect(outbox.map((task) => task.reason)).toEqual(["expired"]);
  });

  it("fences expiry only while the inspected credential version is still current", async () => {
    const now = Date.now();
    await seedAnthropicAccount(now, now + 60_000);
    const accounts = new ModelProviderAccountStore(env.DB);
    const outbox = new ProviderAccountCleanupOutboxStore(env.DB);

    // A reader that inspected version 2 lost to a reconnect: nothing changes.
    expect(await accounts.requireReconnectForExpiredCredential(ANTHROPIC_ACCOUNT_ID, 2, now)).toBe(
      false
    );
    expect((await accounts.getById(ANTHROPIC_ACCOUNT_ID))?.status).toBe("active");
    expect(await outbox.listForAccount(ANTHROPIC_ACCOUNT_ID)).toEqual([]);

    expect(await accounts.requireReconnectForExpiredCredential(ANTHROPIC_ACCOUNT_ID, 1, now)).toBe(
      true
    );
    expect((await accounts.getById(ANTHROPIC_ACCOUNT_ID))?.status).toBe("reconnect_required");
    expect((await outbox.listForAccount(ANTHROPIC_ACCOUNT_ID)).map((task) => task.reason)).toEqual([
      "expired",
    ]);
  });

  it("denies a disabled account, and the cleanup drains its live issuances", async () => {
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
    // Future issuance is denied immediately.
    expect((await fetchRuntimeCredential(sessionName, "sandbox-token", "sandbox-1")).status).toBe(
      409
    );
    // The mutation enqueued the cleanup atomically (trigger).
    const outbox = new ProviderAccountCleanupOutboxStore(env.DB);
    const tasks = await outbox.listForAccount(ANTHROPIC_ACCOUNT_ID);
    expect(tasks.map((task) => task.reason)).toEqual(["disabled"]);

    const revoked: Array<{ sessionId: string; sandboxId: string }> = [];
    const coordinator = new ProviderCredentialCleanupCoordinator(
      new ProviderCredentialIssuanceStore(env.DB),
      outbox,
      {
        async revoke(sessionId, expectedSandboxId) {
          revoked.push({ sessionId, sandboxId: expectedSandboxId });
          return "terminated";
        },
      },
      { info() {}, warn() {}, error() {} },
      () => now + 2
    );
    const result = await coordinator.drain();

    expect(result).toEqual({ tasks: 1, terminated: 1, rescheduled: 0 });
    expect(revoked).toEqual([{ sessionId: sessionName, sandboxId: "sandbox-1" }]);
    expect(await outbox.listForAccount(ANTHROPIC_ACCOUNT_ID)).toEqual([]);
    const issuances = await new ProviderCredentialIssuanceStore(env.DB).listForSession(sessionName);
    expect(issuances[0]?.terminatedAt).toBe(now + 2);
  });

  it("revoke-sandbox on the session runtime stops only the named sandbox", async () => {
    const now = Date.now();
    const sessionName = `issuance-revoke-${now}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "t", sandboxId: "sandbox-1" });

    const stale = await stub.fetch("http://internal/internal/revoke-sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedSandboxId: "sandbox-old", reason: "test" }),
    });
    expect(await stale.json()).toEqual({ outcome: "not_current" });

    const current = await stub.fetch("http://internal/internal/revoke-sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedSandboxId: "sandbox-1", reason: "test" }),
    });
    // The integration provider (Modal) cannot stop a sandbox on request: the
    // runtime is told to exit and the issuance stays unsettled until a later
    // pass finds the sandbox gone.
    expect(await current.json()).toEqual({ outcome: "shutdown_requested" });

    const again = await stub.fetch("http://internal/internal/revoke-sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedSandboxId: "sandbox-1", reason: "test" }),
    });
    expect(await again.json()).toEqual({ outcome: "no_sandbox" });
  });
});
