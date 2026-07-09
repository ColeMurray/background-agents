/**
 * Parse a TEXT column holding a JSON string array (repo_metadata and
 * environments channel-association columns). NULL, malformed JSON, non-array
 * payloads, and arrays with non-string elements all read as `undefined` — the
 * writers only ever store string arrays, so anything else is a corrupt value
 * that degrades to "unset" rather than failing the row or leaking junk through
 * the `string[]` contract.
 */
export function parseJsonStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((element) => typeof element === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
