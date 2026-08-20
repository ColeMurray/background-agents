import { describe, expect, it } from "vitest";
import { prepareLegacyManagedProviderEnv, prepareManagedProviderEnv } from "./managed-provider-env";

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
