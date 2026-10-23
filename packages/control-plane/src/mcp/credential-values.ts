// RFC 7235 auth-scheme followed by RFC 7235 token68. This covers Basic,
// Bearer, Negotiate, and other token-based schemes without treating arbitrary
// whitespace-delimited configuration values as credentials.
const AUTHORIZATION_TOKEN68 = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]+([A-Za-z0-9\-._~+/]+=*)$/;

/** Collect the non-empty credential values the platform actually configured. */
export function collectCredentialValues(
  ...sources: Array<Record<string, unknown> | null | undefined>
): Set<string> {
  const credentials = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string" || value.length === 0) continue;
      credentials.add(value);

      if (key.toLowerCase() === "authorization") {
        const match = AUTHORIZATION_TOKEN68.exec(value);
        if (match) credentials.add(match[1]);
      }
    }
  }
  return credentials;
}

/** Whether a provider result echoes an actual configured credential value at any depth. */
export function containsCredentialValue(
  value: unknown,
  credentialValues: ReadonlySet<string>,
  seen = new Set<object>()
): boolean {
  if (typeof value === "string") {
    for (const credential of credentialValues) {
      if (value.includes(credential)) return true;
    }
    return false;
  }
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialValue(entry, credentialValues, seen));
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      containsCredentialValue(key, credentialValues, seen) ||
      containsCredentialValue(entry, credentialValues, seen)
  );
}
