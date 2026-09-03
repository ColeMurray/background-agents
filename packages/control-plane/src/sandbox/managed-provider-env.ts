import {
  SUBSCRIPTION_PROVIDER_IDS,
  type SessionProviderAuthMode,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

const CONTROL_PLANE_OAUTH_KEYS = new Set([
  "ANTHROPIC_OAUTH_REFRESH_TOKEN",
  "ANTHROPIC_OAUTH_ACCESS_TOKEN",
  "ANTHROPIC_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "ANTHROPIC_OAUTH_MANAGED",
  "OPENAI_OAUTH_REFRESH_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "OPENAI_OAUTH_ACCOUNT_ID",
  "OPENAI_OAUTH_MANAGED",
  "XAI_OAUTH_REFRESH_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN",
  "XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT",
  "XAI_OAUTH_MANAGED",
]);

interface ManagedProviderEnvOptions {
  exposedSecrets: Record<string, string>;
  brokerSecrets: Record<string, string>;
  providerAuthModes: Record<SubscriptionProviderId, SessionProviderAuthMode>;
}

type LegacyManagedProviderEnvOptions = Omit<ManagedProviderEnvOptions, "providerAuthModes">;

const PROVIDER_ENV = {
  anthropic: {
    apiKey: "ANTHROPIC_API_KEY",
    marker: "ANTHROPIC_OAUTH_MANAGED",
  },
  openai: {
    apiKey: "OPENAI_API_KEY",
    marker: "OPENAI_OAUTH_MANAGED",
    legacyRefreshToken: "OPENAI_OAUTH_REFRESH_TOKEN",
  },
  xai: {
    apiKey: "XAI_API_KEY",
    marker: "XAI_OAUTH_MANAGED",
    legacyRefreshToken: "XAI_OAUTH_REFRESH_TOKEN",
  },
} as const satisfies Record<
  SubscriptionProviderId,
  { apiKey: string; marker: string; legacyRefreshToken?: string }
>;

const PROVIDER_AUTH_ERROR = {
  anthropic:
    "No Anthropic authentication is configured for this session. Select a connected Claude account, configure an Anthropic default, or provide ANTHROPIC_API_KEY, then create a new session.",
  openai:
    "No OpenAI authentication is configured for this session. Select a connected ChatGPT account, configure an OpenAI default, or provide OPENAI_API_KEY, then create a new session.",
  xai: "No xAI authentication is configured for this session. Select a connected SuperGrok account, configure an xAI default, or provide XAI_API_KEY, then create a new session.",
} as const satisfies Record<SubscriptionProviderId, string>;

export function getProviderAuthenticationError(
  model: string,
  sandboxEnv: Record<string, string>,
  providerAuthModes: Record<SubscriptionProviderId, SessionProviderAuthMode>,
  platformProvidesAnthropicApiKey = false
): { provider: SubscriptionProviderId; message: string } | null {
  const provider = model.split("/", 1)[0];
  if (provider !== "anthropic" && provider !== "openai" && provider !== "xai") return null;

  const config = PROVIDER_ENV[provider];
  const mode = providerAuthModes[provider];
  // Modal supplies its legacy Anthropic API key as a platform-level secret,
  // outside the D1 secret fold represented by sandboxEnv.
  const available =
    mode === "provider_account"
      ? Boolean(sandboxEnv[config.marker])
      : mode === "api_key"
        ? (provider === "anthropic" && platformProvidesAnthropicApiKey) ||
          Boolean(sandboxEnv[config.apiKey])
        : Boolean(sandboxEnv[config.apiKey] || sandboxEnv[config.marker]);
  return available ? null : { provider, message: PROVIDER_AUTH_ERROR[provider] };
}

export function prepareManagedProviderEnv({
  exposedSecrets,
  brokerSecrets,
  providerAuthModes,
}: ManagedProviderEnvOptions): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(exposedSecrets).filter(([key]) => !CONTROL_PLANE_OAUTH_KEYS.has(key))
  );

  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    const config = PROVIDER_ENV[provider];
    const mode = providerAuthModes[provider];
    const managed =
      mode === "provider_account" ||
      (mode === "legacy_scoped_oauth" &&
        "legacyRefreshToken" in config &&
        Boolean(brokerSecrets[config.legacyRefreshToken]));
    if (managed) {
      // An explicit dummy value also overrides provider-level secrets (such as
      // Modal's llm-api-keys secret), preventing API-key fallback.
      if (provider === "anthropic") env[config.apiKey] = "opencode-oauth-dummy-key";
      else delete env[config.apiKey];
      env[config.marker] = "1";
    }
  }
  return env;
}

/**
 * Image builds predate session provider-routing snapshots. Infer legacy
 * managed OAuth only in that compatibility path; live sessions must call
 * prepareManagedProviderEnv with a complete providerAuthModes record.
 */
export function prepareLegacyManagedProviderEnv({
  exposedSecrets,
  brokerSecrets,
}: LegacyManagedProviderEnvOptions): Record<string, string> {
  return prepareManagedProviderEnv({
    exposedSecrets,
    brokerSecrets,
    providerAuthModes: Object.fromEntries(
      SUBSCRIPTION_PROVIDER_IDS.map((provider) => [
        provider,
        provider !== "anthropic" && brokerSecrets[PROVIDER_ENV[provider].legacyRefreshToken]
          ? "legacy_scoped_oauth"
          : "api_key",
      ])
    ) as Record<SubscriptionProviderId, SessionProviderAuthMode>,
  });
}
