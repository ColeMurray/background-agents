export const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_SIZE = 16384;
export const MAX_TOTAL_VALUE_SIZE = 65536;
export const MAX_SECRETS_PER_SCOPE = 50;

export const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

export class SecretsValidationError extends Error {}

export interface SecretMetadata {
  key: string;
  createdAt: number;
  updatedAt: number;
}

export function normalizeKey(key: string): string {
  return key.toUpperCase();
}

export function validateKey(key: string): void {
  if (!key || key.length > MAX_KEY_LENGTH)
    throw new SecretsValidationError("Key too long or empty");
  if (!VALID_KEY_PATTERN.test(key))
    throw new SecretsValidationError("Key must match [A-Za-z_][A-Za-z0-9_]*");
  if (RESERVED_KEYS.has(key.toUpperCase()))
    throw new SecretsValidationError(`Key '${key}' is reserved`);
}

export function validateValue(value: string): void {
  if (typeof value !== "string") throw new SecretsValidationError("Value must be a string");
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_SIZE)
    throw new SecretsValidationError(`Value exceeds ${MAX_VALUE_SIZE} bytes`);
}

/**
 * Merge global and repo secrets. Repo keys override global keys (case-insensitive).
 * Returns the merged record, total byte size, and whether the combined payload exceeds the limit.
 */
export function mergeSecrets(
  global: Record<string, string>,
  repo: Record<string, string>,
  maxCombinedBytes = 131072
): { merged: Record<string, string>; totalBytes: number; exceedsLimit: boolean } {
  const merged: Record<string, string> = {};

  // Add global secrets first
  for (const [key, value] of Object.entries(global)) {
    merged[normalizeKey(key)] = value;
  }

  // Repo secrets override global
  for (const [key, value] of Object.entries(repo)) {
    merged[normalizeKey(key)] = value;
  }

  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const value of Object.values(merged)) {
    totalBytes += encoder.encode(value).length;
  }

  return { merged, totalBytes, exceedsLimit: totalBytes > maxCombinedBytes };
}
