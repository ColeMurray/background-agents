import { describe, expect, it } from "vitest";
import { prepareManagedProviderEnv } from "./managed-provider-env";

describe("prepareManagedProviderEnv", () => {
  it("replaces durable OAuth credentials with provider markers", () => {
    expect(
      prepareManagedProviderEnv({
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
      prepareManagedProviderEnv({
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
      prepareManagedProviderEnv({
        exposedSecrets: { XAI_OAUTH_REFRESH_TOKEN: "secondary", USER_VALUE: "visible" },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "primary" },
      })
    ).toEqual({ USER_VALUE: "visible", OPENAI_OAUTH_MANAGED: "1" });
  });

  it("lets an explicit provider API key override managed OAuth", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          OPENAI_API_KEY: "sk-openai",
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
        },
        brokerSecrets: {
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
          XAI_OAUTH_REFRESH_TOKEN: "xai-refresh",
        },
      })
    ).toEqual({ OPENAI_API_KEY: "sk-openai", XAI_OAUTH_MANAGED: "1" });
  });

  it("keeps managed OAuth when the API key belongs to another provider", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: { XAI_API_KEY: "xai-key" },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh" },
      })
    ).toEqual({ XAI_API_KEY: "xai-key", OPENAI_OAUTH_MANAGED: "1" });
  });

  it("keeps managed OAuth alongside a spillover fallback key", () => {
    expect(
      prepareManagedProviderEnv({
        exposedSecrets: {
          OPENAI_API_KEY_FALLBACK: "sk-fallback",
          OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh",
        },
        brokerSecrets: { OPENAI_OAUTH_REFRESH_TOKEN: "openai-refresh" },
      })
    ).toEqual({ OPENAI_API_KEY_FALLBACK: "sk-fallback", OPENAI_OAUTH_MANAGED: "1" });
  });
});
