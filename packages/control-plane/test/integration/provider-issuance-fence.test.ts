import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderCredentialStore } from "../../src/db/provider-account-credentials";
import * as runtimeClient from "../../src/session/runtime-client";
import { SessionInternalPaths } from "../../src/session/contracts";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, routeRequest, seedSandboxAuth } from "./helpers";

describe("OAuth credential issuance version fence", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["openai", "usage write"],
    ["openai", "final generation check"],
    ["xai", "usage write"],
    ["xai", "final generation check"],
  ] as const)("rejects a replaced %s credential during %s", async (provider, boundary) => {
    const accountId = "a".repeat(32);
    const sessionId = `issuance-${provider}-${crypto.randomUUID()}`;
    const now = Date.now();
    const credentials = new ProviderCredentialStore(env.DB, env.PROVIDER_ACCOUNTS_ENCRYPTION_KEY!);
    await new ModelProviderAccountStore(env.DB).create({
      id: accountId,
      provider,
      displayName: "Fence test",
      externalAccountId: "test-account",
      now,
    });
    const credential = {
      providerAccountId: accountId,
      provider,
      credentialSchemaVersion: 1,
      payload: {
        refreshToken: "test-refresh",
        accessToken: "superseded-secret",
        accessTokenExpiresAt: now + 3_600_000,
        accountId: "test-account",
      },
      accessTokenExpiresAt: now + 3_600_000,
      now,
    };
    await credentials.create(credential);
    const { stub } = await initNamedSession(sessionId, {
      providerAuth: (["openai", "xai", "anthropic"] as const).map((id) =>
        id === provider
          ? {
              provider: id,
              authMode: "provider_account" as const,
              providerAccountId: accountId,
              selectionSource: "explicit",
            }
          : { provider: id, authMode: "api_key" as const, selectionSource: "explicit" }
      ),
    });
    await seedSandboxAuth(stub, { authToken: "test-sandbox-token", sandboxId: "test-sandbox" });
    const replace = async () => {
      expect(
        await credentials.replace({
          ...credential,
          expectedCredentialVersion: 1,
          payload: { ...credential.payload, accessToken: "replacement-secret" },
        })
      ).toBe(true);
    };
    let replaceAtVerification = false;
    vi.spyOn(ModelProviderAccountStore.prototype, "touchLastUsed").mockImplementationOnce(
      async () => {
        if (boundary === "usage write") await replace();
        else replaceAtVerification = true;
        return true;
      }
    );
    const originalClient = runtimeClient.createSessionRuntimeClient;
    vi.spyOn(runtimeClient, "createSessionRuntimeClient").mockImplementation((host, context) => {
      const client = originalClient(host, context);
      return {
        fetch: async (id, path, init, search) => {
          if (replaceAtVerification && path === SessionInternalPaths.verifySandboxToken) {
            replaceAtVerification = false;
            await replace();
          }
          return client.fetch(id, path, init, search);
        },
      };
    });
    const request = () =>
      routeRequest(
        new Request(
          `http://localhost/sessions/${sessionId}/provider-auth/${provider}/access-token`,
          {
            method: "POST",
            headers: { Authorization: "Bearer test-sandbox-token" },
          }
        ),
        env,
        createExecutionContext()
      );
    const stale = await request();
    expect(stale.status).toBe(409);
    expect(stale.headers.get("Cache-Control")).toBe("no-store");
    expect(await stale.json()).toEqual({ error: "stale_provider_binding" });
    const current = await request();
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      accessToken: "replacement-secret",
      credentialVersion: 2,
      bindingRevision: 1,
    });
  });
});
