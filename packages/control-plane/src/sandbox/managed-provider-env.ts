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

export function prepareManagedProviderEnv(
  secrets: Record<string, string>,
  managedSecrets: Record<string, string> = secrets
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(secrets).filter(([key]) => !CONTROL_PLANE_OAUTH_KEYS.has(key))
  );
  if (managedSecrets.OPENAI_OAUTH_REFRESH_TOKEN) env.OPENAI_OAUTH_MANAGED = "1";
  if (managedSecrets.XAI_OAUTH_REFRESH_TOKEN) env.XAI_OAUTH_MANAGED = "1";
  return env;
}
