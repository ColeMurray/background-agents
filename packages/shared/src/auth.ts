/**
 * Internal API authentication utilities.
 *
 * Provides HMAC-SHA256 time-based token generation and verification
 * for service-to-service authentication between Open-Inspect components.
 */

/**
 * Token validity window in milliseconds (5 minutes).
 * Tokens older than this are rejected to prevent replay attacks.
 */
const TOKEN_VALIDITY_MS = 5 * 60 * 1000;

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Generate an internal API token for service-to-service calls.
 *
 * Token format: `timestamp.signature` where:
 * - timestamp: Unix milliseconds when the token was generated
 * - signature: HMAC-SHA256 of the timestamp using the shared secret
 *
 * @param secret - The shared secret for HMAC signing
 * @returns A token string in the format "timestamp.signature"
 */
export async function generateInternalToken(secret: string): Promise<string> {
  const timestamp = Date.now().toString();
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp));
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `${timestamp}.${signatureHex}`;
}

/**
 * Verify an internal API token from the Authorization header.
 *
 * @param authHeader - The Authorization header value (e.g., "Bearer timestamp.signature")
 * @param secret - The shared secret for HMAC verification
 * @returns true if the token is valid, false otherwise
 */
export async function verifyInternalToken(
  authHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7);
  const [timestamp, signature] = token.split(".");

  if (!timestamp || !signature) {
    return false;
  }

  // Reject tokens outside the validity window
  const tokenTime = parseInt(timestamp, 10);
  const now = Date.now();
  if (isNaN(tokenTime) || Math.abs(now - tokenTime) > TOKEN_VALIDITY_MS) {
    return false;
  }

  // Verify HMAC signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedSig = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp));
  const expectedHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(signature, expectedHex);
}
