import { describe, expect, it } from "vitest";
import {
  getProviderAuthenticationError,
  prepareLegacyManagedProviderEnv,
  prepareManagedProviderEnv,
} from "./managed-provider-env";

describe("prepareLegacyManagedProviderEnv", () => {
  it("replaces durable OAuth credentials with provider markers", () => {
    expect(
      prepareLegacyManagedProviderEnv({
        exposedSecrets: {
          USER_VALUE: "visible",
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          OPENAI_OAUTH_ACCESS_TOKEN: "openai-access",
          OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "123",
          OPENAI_OAUTH_ACCOUNT_ID: "account",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
          XAI_OAUTH_ACCESS_TOKEN: "xai-access",
          XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "456",
        },
        brokerSecrets: {
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
        },
      })
    ).toEqual({
      USER_VALUE: "visible",
      OPENAI_OAUTH_MANAGED: "1",
      XAI_OAUTH_MANAGED: "1",
    });
  });

  it("does not advertise a provider without a refresh token", () => {
    expect(
      prepareLegacyManagedProviderEnv({
        exposedSecrets: {
          XAI_OAUTH_ACCESS_TOKEN: "orphaned",
          XAI_OAUTH_MANAGED: "user-controlled",
        },
        brokerSecrets: {},
      })
    ).toEqual({});
  });

  it("uses broker-compatible scopes to choose managed markers", () => {
    expect(
      prepareLegacyManagedProviderEnv({
        exposedSecrets: { XAI_OAUTH_REFRESH_TOKEN: "secondary", USER_VALUE: "visible" },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "primary" },
      })
    ).toEqual({ USER_VALUE: "visible", OPENAI_OAUTH_MANAGED: "1" });
  });
});

describe("prepareManagedProviderEnv", () => {
  it("makes provider-account mode override legacy OAuth and canonical API keys", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          OPENAI_API_KEY: "sk-openai",
          OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai",
          OPENAI_OAUTH_MANAGED: "user-controlled",
          XAI_API_KEY: "xai-key",
          XAI_OAUTH_REFRESH_TOKEN: "legacy-xai",
          USER_VALUE: "visible",
        },
        brokerSecrets: {
          OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai",
          XAI_OAUTH_REFRESH_TOKEN: "legacy-xai",
        },
        providerAuthModes: {
          openai: "provider_account",
          xai: "api_key",
        },
      })
    ).toEqual({
      OPENAI_OAUTH_MANAGED: "1",
      XAI_API_KEY: "xai-key",
      USER_VALUE: "visible",
    });
  });

  it("retains canonical API keys and removes managed state in explicit API-key mode", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          OPENAI_API_KEY: "sk-openai",
          OPENAI_OAUTH_ACCESS_TOKEN: "legacy-access",
          OPENAI_OAUTH_MANAGED: "1",
          XAI_API_KEY: "xai-key",
          XAI_OAUTH_ACCESS_TOKEN: "legacy-access",
          XAI_OAUTH_MANAGED: "1",
        },
        brokerSecrets: {
          OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai",
          XAI_OAUTH_REFRESH_TOKEN: "legacy-xai",
        },
        providerAuthModes: {
          openai: "api_key",
          xai: "api_key",
        },
      })
    ).toEqual({ OPENAI_API_KEY: "sk-openai", XAI_API_KEY: "xai-key" });
  });

  it("uses scoped OAuth only when a legacy-bound provider has a compatible refresh token", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: { OPENAI_API_KEY: "sk-openai", XAI_API_KEY: "xai-key" },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "legacy-openai" },
        providerAuthModes: {
          openai: "legacy_scoped_oauth",
          xai: "legacy_scoped_oauth",
        },
      })
    ).toEqual({ OPENAI_OAUTH_MANAGED: "1", XAI_API_KEY: "xai-key" });
  });
});

describe("getProviderAuthenticationError", () => {
  it("rejects a Grok launch whose legacy fallback has no usable xAI credential", () => {
    expect(
      getProviderAuthenticationError(
        "xai/grok-4.5",
        {},
        {
          openai: "legacy_scoped_oauth",
          xai: "legacy_scoped_oauth",
        }
      )
    ).toEqual({
      provider: "xai",
      message:
        "No xAI authentication is configured for this session. Select a connected SuperGrok account, configure an xAI default, or provide XAI_API_KEY, then create a new session.",
    });
  });

  it.each([
    ["provider account", { XAI_OAUTH_MANAGED: "1" }, "provider_account"],
    ["API key", { XAI_API_KEY: "configured" }, "api_key"],
    ["legacy refresh token", { XAI_OAUTH_MANAGED: "1" }, "legacy_scoped_oauth"],
  ] as const)("accepts xAI %s authentication", (_label, sandboxEnv, authMode) => {
    expect(
      getProviderAuthenticationError("xai/grok-4.5", sandboxEnv, {
        openai: "legacy_scoped_oauth",
        xai: authMode,
      })
    ).toBeNull();
  });

  it("rejects explicit OpenAI API-key mode without an API key", () => {
    expect(
      getProviderAuthenticationError(
        "openai/gpt-5.4",
        {},
        {
          openai: "api_key",
          xai: "legacy_scoped_oauth",
        }
      )?.message
    ).toContain("OPENAI_API_KEY");
  });

  it("does not validate providers outside subscription account routing", () => {
    expect(
      getProviderAuthenticationError(
        "anthropic/claude-opus-4-6",
        {},
        {
          openai: "legacy_scoped_oauth",
          xai: "legacy_scoped_oauth",
        }
      )
    ).toBeNull();
  });
});
