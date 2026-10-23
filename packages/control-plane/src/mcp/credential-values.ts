/** Collect the non-empty credential values the platform actually configured. */
export function collectCredentialValues(
  ...sources: Array<Record<string, unknown> | null | undefined>
): Set<string> {
  const credentials = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const value of Object.values(source)) {
      if (typeof value === "string" && value.length > 0) credentials.add(value);
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
