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
  "ANTHROPIC_OAUTH_MANAGED",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

interface ManagedProviderEnvOptions {
  exposedSecrets: Record<string, string>;
  brokerSecrets: Record<string, string>;
  providerAuthModes: Record<SubscriptionProviderId, SessionProviderAuthMode>;
}

type LegacyManagedProviderEnvOptions = Omit<ManagedProviderEnvOptions, "providerAuthModes">;

interface ProviderEnvConfig {
  apiKey: string;
  marker: string;
  /** Legacy scoped-OAuth refresh token key; absent for providers that never had one. */
  legacyRefreshToken: string | null;
  /**
   * User-secret keys stripped in provider_account mode so a stale user key or
   * gateway setting cannot shadow the managed credential. Defence in depth:
   * the platform's own key never passes through this fold.
   */
  strip: readonly string[];
  /**
   * Whether an api_key session can be validated from the assembled env. The
   * Anthropic platform key arrives out of band on Modal (a Secret), so its
   * absence here proves nothing.
   */
  apiKeyVisibleInEnv: boolean;
}

const PROVIDER_ENV = {
  openai: {
    apiKey: "OPENAI_API_KEY",
    marker: "OPENAI_OAUTH_MANAGED",
    legacyRefreshToken: "OPENAI_OAUTH_REFRESH_TOKEN",
    strip: [],
    apiKeyVisibleInEnv: true,
  },
  xai: {
    apiKey: "XAI_API_KEY",
    marker: "XAI_OAUTH_MANAGED",
    legacyRefreshToken: "XAI_OAUTH_REFRESH_TOKEN",
    strip: [],
    apiKeyVisibleInEnv: true,
  },
  anthropic: {
    apiKey: "ANTHROPIC_API_KEY",
    marker: "ANTHROPIC_OAUTH_MANAGED",
    legacyRefreshToken: null,
    strip: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
    apiKeyVisibleInEnv: false,
  },
} as const satisfies Record<SubscriptionProviderId, ProviderEnvConfig>;

const PROVIDER_AUTH_ERROR = {
  openai:
    "No OpenAI authentication is configured for this session. Select a connected ChatGPT account, configure an OpenAI default, or provide OPENAI_API_KEY, then create a new session.",
  xai: "No xAI authentication is configured for this session. Select a connected SuperGrok account, configure an xAI default, or provide XAI_API_KEY, then create a new session.",
  anthropic:
    "No Anthropic authentication is configured for this session. Select a connected Claude account, configure an Anthropic default, or provide ANTHROPIC_API_KEY, then create a new session.",
} as const satisfies Record<SubscriptionProviderId, string>;

function isSubscriptionProvider(provider: string): provider is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(provider);
}

export function getProviderAuthenticationError(
  model: string,
  sandboxEnv: Record<string, string>,
  providerAuthModes: Record<SubscriptionProviderId, SessionProviderAuthMode>
): { provider: SubscriptionProviderId; message: string } | null {
  const provider = model.split("/", 1)[0];
  if (!isSubscriptionProvider(provider)) return null;

  const config = PROVIDER_ENV[provider];
  const mode = providerAuthModes[provider];
  if (mode !== "provider_account" && !config.apiKeyVisibleInEnv) return null;
  const available =
    mode === "provider_account"
      ? Boolean(sandboxEnv[config.marker])
      : mode === "api_key"
        ? Boolean(sandboxEnv[config.apiKey])
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
        config.legacyRefreshToken !== null &&
        Boolean(brokerSecrets[config.legacyRefreshToken]));
    if (managed) {
      delete env[config.apiKey];
      for (const key of config.strip) delete env[key];
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE_CODE_OAUTH_") && provider === "anthropic") delete env[key];
      }
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
      SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
        const legacyKey = PROVIDER_ENV[provider].legacyRefreshToken;
        return [
          provider,
          legacyKey !== null && brokerSecrets[legacyKey] ? "legacy_scoped_oauth" : "api_key",
        ];
      })
    ) as Record<SubscriptionProviderId, SessionProviderAuthMode>,
  });
}
