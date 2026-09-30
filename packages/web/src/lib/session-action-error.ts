/** Preserve the server's denial reason without changing other action-error messages. */
export async function sessionActionErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  if (response.status !== 403) return fallback;
  const body: unknown = await response.json().catch(() => null);
  if (
    body &&
    typeof body === "object" &&
    "reason_code" in body &&
    typeof body.reason_code === "string" &&
    body.reason_code.trim()
  ) {
    return `${fallback} (${body.reason_code})`;
  }
  return fallback;
}
