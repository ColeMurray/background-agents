const CANONICAL_USER_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isCanonicalUserId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_USER_ID_PATTERN.test(value);
}
