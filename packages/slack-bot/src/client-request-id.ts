/** Build a bounded, deterministic idempotency key without exposing its inputs. */
export async function deriveClientRequestId(namespace: string, parts: string[]): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
  return `${namespace}:${hex}`;
}
