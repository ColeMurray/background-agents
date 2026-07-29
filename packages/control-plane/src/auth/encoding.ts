/**
 * Byte-level encoding helpers shared by the auth layer.
 */

/** Base64url-encode bytes or a UTF-8 string (RFC 4648 §5, unpadded). */
export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
