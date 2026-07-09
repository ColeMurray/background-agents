/**
 * Parse a TEXT column holding a JSON string array (repo_metadata and
 * environments channel-association columns). NULL, malformed JSON, and
 * non-array payloads all read as `undefined` — a corrupt column degrades to
 * "unset" rather than failing the row.
 */
export function parseJsonStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
