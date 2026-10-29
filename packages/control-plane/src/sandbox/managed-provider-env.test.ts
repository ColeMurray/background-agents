import { describe, expect, it } from "vitest";
import { prepareManagedProviderEnv } from "./managed-provider-env";

describe("prepareManagedProviderEnv", () => {
  it.each(["api_key", "provider_account"] as const)(
    "removes competing native Codex authority in %s mode",
    (mode) => {
      const result = prepareManagedProviderEnv({
        harness: "codex",
        brokerSecrets: {},
        exposedSecrets: {
          OPENAI_API_KEY: "selected",
          OPENAI_BASE_URL: "https://other",
          OPENAI_ORG_ID: "other-org",
          CODEX_API_KEY: "unselected",
          CODEX_ACCESS_TOKEN: "unselected",
          CODEX_HOME: "/other",
          CODEX_SQLITE_HOME: "/other",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://other",
          USER_BUILD_VAR: "keep",
        },
        providerAuthModes: { openai: mode, xai: "api_key", anthropic: "api_key" },
      });
      expect(result).toEqual(
        mode === "api_key"
          ? { OPENAI_API_KEY: "selected", USER_BUILD_VAR: "keep" }
          : { OPENAI_OAUTH_MANAGED: "1", USER_BUILD_VAR: "keep" }
      );
    }
  );

  it("does not change OpenCode native environment compatibility", () => {
    expect(
      prepareManagedProviderEnv({
        harness: "opencode",
        exposedSecrets: {
          CODEX_HOME: "/custom",
          OPENAI_API_KEY: "selected",
          OPENAI_BASE_URL: "https://custom",
        },
        brokerSecrets: {},
        providerAuthModes: { openai: "api_key", xai: "api_key", anthropic: "api_key" },
      })
    ).toEqual({
      CODEX_HOME: "/custom",
      OPENAI_API_KEY: "selected",
      OPENAI_BASE_URL: "https://custom",
    });
  });
});
