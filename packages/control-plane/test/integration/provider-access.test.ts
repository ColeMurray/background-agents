import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderAccountBroker } from "../../src/auth/model-provider-account-broker";
import { ModelProviderAccountAdapterRegistry } from "../../src/auth/model-provider-account-adapters";
import { OpenAIModelProviderAccountAdapter } from "../../src/auth/model-provider-account-openai-adapter";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import { D1ModelProviderAccountAtomicWriter } from "../../src/db/model-provider-account-atomic-writer";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";

const ACCOUNT = "c".repeat(32);
const ID_TOKEN = "eyJhbGciOiJub25lIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LWludGVncmF0aW9uIn0.";

async function fixture() {
  const now = Date.now();
  const accounts = new ModelProviderAccountStore(env.DB);
  await accounts.create({
    id: ACCOUNT,
    provider: "openai",
    displayName: "Connected",
    externalAccountId: "acct-integration",
    status: "active",
    now,
  });
  const credentials = new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
  await credentials.create({
    providerAccountId: ACCOUNT,
    provider: "openai",
    credentialSchemaVersion: 1,
    payload: {
      refreshToken: "integration-openai-refresh",
      accessToken: "cached-rejected",
      accountId: "acct-integration",
      accessTokenExpiresAt: now + 3_600_000,
    },
    accessTokenExpiresAt: now + 3_600_000,
    now,
  });
  const sessionId = `codex-access-${now}`;
  const { stub } = await initNamedSession(sessionId, {
    providerAuth: [
      {
        provider: "openai",
        authMode: "provider_account",
        providerAccountId: ACCOUNT,
        selectionSource: "explicit",
      },
      { provider: "xai", authMode: "api_key", selectionSource: "explicit" },
      { provider: "anthropic", authMode: "api_key", selectionSource: "explicit" },
    ],
  });
  await seedSandboxAuth(stub, { authToken: "sandbox-secret", sandboxId: "sandbox-connected" });
  const fetch = (body?: unknown, headers?: Record<string, string>) =>
    SELF.fetch(`https://test.local/sessions/${sessionId}/provider-auth/openai/access-token`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sandbox-secret",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { accounts, credentials, sessionId, fetch };
}

describe("connected provider access", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("refreshes a fresh rejected version once and reuses the newer committed credential", async () => {
    const f = await fixture();
    const normal = await f.fetch();
    expect(normal.status).toBe(200);
    expect(await normal.json()).toMatchObject({
      accessToken: "cached-rejected",
      credentialVersion: 1,
      expiresAt: expect.any(Number),
    });
    const rejection = { reason: "unauthorized", rejectedCredentialVersion: 1 };
    const rotated = await f.fetch(rejection, {
      "X-Provider-Deadline-Ms": String(Date.now() + 7500),
    });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("Cache-Control")).toBe("no-store");
    const issued = await rotated.json();
    expect(issued).toMatchObject({
      accessToken: "integration-openai-access-token",
      credentialVersion: 2,
      externalAccountId: "acct-integration",
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(issued)).not.toContain("rotated-refresh");
    const reused = await f.fetch(rejection);
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ credentialVersion: 2 });
    expect(await f.credentials.readCredentialState(ACCOUNT, "openai")).toMatchObject({
      credentialVersion: 2,
      exchangeState: "idle",
      payload: { refreshToken: "integration-openai-rotated-refresh" },
    });
  });

  it("rejects malformed version/account requests, elapsed deadlines and invalid sandbox authentication without secrets", async () => {
    const f = await fixture();
    for (const body of [
      { reason: "unauthorized" },
      { rejectedCredentialVersion: 1 },
      { reason: "unauthorized", rejectedCredentialVersion: true },
      { reason: "unauthorized", rejectedCredentialVersion: 0 },
      { reason: "unauthorized", rejectedCredentialVersion: 1.5 },
      { accountId: ACCOUNT },
    ]) {
      const response = await f.fetch(body);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).not.toContain("cached-rejected");
    }
    expect((await f.fetch({}, { "X-Provider-Deadline-Ms": "1" })).status).toBe(504);
    expect((await f.fetch({}, { Authorization: "Bearer invalid-sandbox-secret" })).status).toBe(
      401
    );
  });

  it("preserves the existing refusal to issue credentials for disabled accounts", async () => {
    const f = await fixture();
    await f.accounts.setStatus(ACCOUNT, "disabled", null, Date.now());
    const response = await f.fetch();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("cached-rejected");
  });

  it("shares one rotating grant across independent broker instances and rejected-version callers", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await gate;
      return {
        access_token: "winner",
        refresh_token: "rotated",
        expires_in: 3600,
        id_token: ID_TOKEN,
      };
    });
    const registry = new ModelProviderAccountAdapterRegistry([
      new OpenAIModelProviderAccountAdapter(refresh),
    ]);
    const stores = {
      accounts: f.accounts,
      credentials: f.credentials,
      atomicWriter: new D1ModelProviderAccountAtomicWriter(
        env.DB,
        env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!
      ),
    };
    const a = new ModelProviderAccountBroker(stores, registry, { pollDelayMs: 5 });
    const b = new ModelProviderAccountBroker(stores, registry, { pollDelayMs: 5 });
    const first = a.getAccess(ACCOUNT, "openai", { rejectedCredentialVersion: 1 });
    const second = b.getAccess(ACCOUNT, "openai", { rejectedCredentialVersion: 1 });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    release();
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ accessToken: "winner", credentialVersion: 2 }),
      expect.objectContaining({ accessToken: "winner", credentialVersion: 2 }),
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
