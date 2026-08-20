import {
  SUBSCRIPTION_PROVIDER_IDS,
  type SessionProviderAuthMode,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

const CONTROL_PLANE_OAUTH_KEYS = new Set([
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
  { apiKey: string; marker: string; legacyRefreshToken: string }
>;

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
      (mode === "legacy_scoped_oauth" && Boolean(brokerSecrets[config.legacyRefreshToken]));
    if (managed) {
      delete env[config.apiKey];
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
        brokerSecrets[PROVIDER_ENV[provider].legacyRefreshToken]
          ? "legacy_scoped_oauth"
          : "api_key",
      ])
    ) as Record<SubscriptionProviderId, SessionProviderAuthMode>,
  });
}
