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

/**
 * Providers whose subscription OAuth the control plane brokers. An explicit
 * API key for the same provider wins: OpenCode's provider loader keeps the
 * OAuth plugin's dummy key ahead of the env var, so leaving broker mode on
 * would silently ignore the key the operator just installed.
 */
const MANAGED_PROVIDERS = [
  {
    refreshTokenKey: "OPENAI_OAUTH_REFRESH_TOKEN",
    markerKey: "OPENAI_OAUTH_MANAGED",
    apiKey: "OPENAI_API_KEY",
  },
  {
    refreshTokenKey: "XAI_OAUTH_REFRESH_TOKEN",
    markerKey: "XAI_OAUTH_MANAGED",
    apiKey: "XAI_API_KEY",
  },
] as const;

interface ManagedProviderEnvOptions {
  exposedSecrets: Record<string, string>;
  brokerSecrets: Record<string, string>;
}

export function prepareManagedProviderEnv({
  exposedSecrets,
  brokerSecrets,
}: ManagedProviderEnvOptions): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(exposedSecrets).filter(([key]) => !CONTROL_PLANE_OAUTH_KEYS.has(key))
  );
  for (const provider of MANAGED_PROVIDERS) {
    if (brokerSecrets[provider.refreshTokenKey] && !env[provider.apiKey]) {
      env[provider.markerKey] = "1";
    }
  }
  return env;
}
