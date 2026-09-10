import { describe, expect, it, vi } from "vitest";
import {
  AnthropicModelProviderAccountAdapter,
  AnthropicProviderAuthorizationCode,
  type AnthropicProviderCredential,
} from "./model-provider-account-anthropic-adapter";
import { ANTHROPIC_SETUP_TOKEN_LIFETIME_MS, AnthropicTokenExchangeError } from "./anthropic";
import { modelProviderAccountAdapterRegistry } from "./model-provider-account-default-adapters";
import { ProviderCredentialError, ProviderRefreshError } from "./model-provider-account-adapters";

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function credential(expiresAt: number): AnthropicProviderCredential {
  return {
    kind: "setup_token",
    token: "sk-ant-oat01-stored",
    expiresAt,
    scopes: ["user:inference"],
  };
}

describe("AnthropicModelProviderAccountAdapter", () => {
  const adapter = new AnthropicModelProviderAccountAdapter(undefined, () => NOW);

  it("is registered as a static-credential, authorization-code provider", () => {
    expect(modelProviderAccountAdapterRegistry.get("anthropic")).toBeInstanceOf(
      AnthropicModelProviderAccountAdapter
    );
    expect(modelProviderAccountAdapterRegistry.runtimeCredentialKind("anthropic")).toBe(
      "sandbox_bootstrap_secret"
    );
    expect(modelProviderAccountAdapterRegistry.requireAuthorizationCode("anthropic")).toMatchObject(
      { stateSchemaVersion: 1 }
    );
    expect(() =>
      modelProviderAccountAdapterRegistry.requireDeviceAuthorization("anthropic")
    ).toThrow(/unavailable/);
    expect(adapter.supportsVerification).toBe(false);
  });

  it("accepts a pasted setup token with the documented lifetime", async () => {
    await expect(
      adapter.connect({
        provider: "anthropic",
        displayName: "Claude",
        setupToken: "  sk-ant-oat01-pasted  ",
      })
    ).resolves.toEqual({
      credential: {
        kind: "setup_token",
        token: "sk-ant-oat01-pasted",
        expiresAt: NOW + ANTHROPIC_SETUP_TOKEN_LIFETIME_MS,
        scopes: ["user:inference"],
      },
      accessTokenExpiresAt: NOW + ANTHROPIC_SETUP_TOKEN_LIFETIME_MS,
    });
  });

  it.each(["sk-ant-api03-key", "oat-sk-ant", "", "   "])(
    "rejects %j as a setup token",
    async (setupToken) => {
      await expect(adapter.connect({ provider: "anthropic", setupToken })).rejects.toBeInstanceOf(
        ProviderCredentialError
      );
    }
  );

  it("parses only the canonical connect and reconnect request shapes", () => {
    expect(
      adapter.parseConnectInput({ provider: "anthropic", displayName: "Claude", setupToken: "x" })
    ).toEqual({ provider: "anthropic", displayName: "Claude", setupToken: "x" });
    expect(adapter.parseConnectInput({ provider: "anthropic", setupToken: "x" })).toEqual({
      provider: "anthropic",
      setupToken: "x",
    });
    expect(() =>
      adapter.parseConnectInput({ provider: "anthropic", setupToken: "x", accountId: "acct" })
    ).toThrow();
    expect(() => adapter.parseConnectInput({ provider: "openai", setupToken: "x" })).toThrow();
  });

  it("returns the same credential from refresh while it is still valid", async () => {
    const stored = credential(NOW + 2 * HOUR_MS);
    await expect(adapter.refresh(stored)).resolves.toEqual({
      credential: stored,
      accessToken: "sk-ant-oat01-stored",
      accessTokenExpiresAt: NOW + 2 * HOUR_MS,
    });
  });

  it.each([
    ["inside the expiry guard", NOW + HOUR_MS],
    ["after expiry", NOW - 1],
  ])("requires reconnection %s", async (_label, expiresAt) => {
    const error = await adapter.refresh(credential(expiresAt)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderRefreshError);
    expect(error).toMatchObject({ classification: "unauthorized" });
  });

  it("always serves the stored token as cached access", () => {
    expect(adapter.cachedAccess(credential(NOW - 1))).toEqual({
      accessToken: "sk-ant-oat01-stored",
      accessTokenExpiresAt: NOW - 1,
    });
  });

  it("validates the persisted credential schema and version", () => {
    expect(adapter.parseCredential(credential(NOW), 1)).toEqual(credential(NOW));
    expect(() => adapter.parseCredential(credential(NOW), 2)).toThrow(ProviderCredentialError);
    expect(() => adapter.parseCredential({ token: "x" }, 1)).toThrow(ProviderCredentialError);
  });

  it("exposes no runtime metadata and only rejects contradicting identities", () => {
    expect(adapter.runtimeMetadata(credential(NOW), null)).toEqual({});
    expect(() => adapter.validateExternalIdentity(undefined, null)).not.toThrow();
    expect(() => adapter.validateExternalIdentity(undefined, "acct")).not.toThrow();
    expect(() => adapter.validateExternalIdentity("acct", null)).not.toThrow();
    expect(() => adapter.validateExternalIdentity("a", "b")).toThrow(/did not match/);
    expect(() =>
      adapter.validateReconnectInputIdentity({ provider: "anthropic", setupToken: "x" }, "acct")
    ).not.toThrow();
  });
});

describe("AnthropicProviderAuthorizationCode", () => {
  it("starts with only the verifier and state persisted", async () => {
    const capability = new AnthropicProviderAuthorizationCode(async () => ({
      authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
      codeVerifier: "verifier",
      state: "state",
    }));

    await expect(capability.start()).resolves.toEqual({
      providerState: { codeVerifier: "verifier", state: "state" },
      authorizationUrl: "https://claude.ai/oauth/authorize?code=true",
    });
  });

  it("validates persisted state and its schema version", () => {
    const capability = new AnthropicProviderAuthorizationCode();
    expect(capability.parseState({ codeVerifier: "v", state: "s" }, 1)).toEqual({
      codeVerifier: "v",
      state: "s",
    });
    expect(() => capability.parseState({ codeVerifier: "v", state: "s" }, 2)).toThrow(
      ProviderCredentialError
    );
    expect(() => capability.parseState({ codeVerifier: "v" }, 1)).toThrow(ProviderCredentialError);
  });

  it("exchanges the pasted code against the persisted verifier and state", async () => {
    const exchange = vi.fn(async () => ({
      accessToken: "sk-ant-oat01-new",
      expiresAt: NOW + HOUR_MS,
      scope: "user:inference user:profile",
      tokenUuid: "token-uuid",
      account: { uuid: "account-uuid", email: "owner@example.com" },
      organization: { uuid: "org-uuid", name: "Owner Org" },
    }));
    const capability = new AnthropicProviderAuthorizationCode(undefined, exchange);

    await expect(
      capability.complete({ codeVerifier: "verifier", state: "state" }, "code#state")
    ).resolves.toEqual({
      credential: {
        kind: "setup_token",
        token: "sk-ant-oat01-new",
        expiresAt: NOW + HOUR_MS,
        scopes: ["user:inference", "user:profile"],
        tokenUuid: "token-uuid",
        organizationName: "Owner Org",
      },
      // The granting account becomes the slot's identity.
      externalAccountId: "account-uuid",
      accessTokenExpiresAt: NOW + HOUR_MS,
    });
    expect(exchange).toHaveBeenCalledWith({
      code: "code",
      pastedState: "state",
      expectedState: "state",
      codeVerifier: "verifier",
    });
  });

  it("stays identity-less when the exchange names no account", async () => {
    const exchange = vi.fn(async () => ({
      accessToken: "sk-ant-oat01-new",
      expiresAt: NOW + HOUR_MS,
      scope: "user:inference",
    }));
    const capability = new AnthropicProviderAuthorizationCode(undefined, exchange);
    const result = await capability.complete({ codeVerifier: "v", state: "s" }, "code#s");
    expect(result.externalAccountId).toBeUndefined();
    expect(result.credential).toEqual({
      kind: "setup_token",
      token: "sk-ant-oat01-new",
      expiresAt: NOW + HOUR_MS,
      scopes: ["user:inference"],
      tokenUuid: undefined,
      organizationName: undefined,
    });
  });

  it("propagates exchange failures untouched", async () => {
    const capability = new AnthropicProviderAuthorizationCode(undefined, async () => {
      throw new AnthropicTokenExchangeError("used", "invalid_grant");
    });

    await expect(
      capability.complete({ codeVerifier: "verifier", state: "state" }, "code")
    ).rejects.toMatchObject({ reason: "invalid_grant" });
  });
});
