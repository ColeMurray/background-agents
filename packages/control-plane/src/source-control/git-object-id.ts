/** Git repositories use full SHA-1 (40 hex) or SHA-256 (64 hex) object IDs. */
export const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isFullGitObjectId(value: string): boolean {
  return FULL_GIT_OBJECT_ID_PATTERN.test(value);
}

export function requireFullGitObjectId(value: string): string {
  const normalized = value.trim();
  if (!isFullGitObjectId(normalized)) {
    throw new Error("Expected a full Git object SHA");
  }
  return normalized;
}
