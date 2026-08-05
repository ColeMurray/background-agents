/**
 * Internal API authentication utilities.
 *
 * Provides HMAC-SHA256 time-based token generation and verification
 * for service-to-service authentication between Open-Inspect components.
 */

/**
 * Token validity window in milliseconds (5 minutes).
 * Tokens older than this are rejected to prevent replay attacks.
 * Shared by the MODAL_API_SECRET internal token and the sig1 service signature.
 */
export const TOKEN_VALIDITY_MS = 5 * 60 * 1000;

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
 * Encode bytes as a lowercase hex string.
 *
 * Internal helper shared with `service-auth.ts` (HMAC, digest, and nonce hex
 * encoding); exported for that module, not intended as public package surface.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute HMAC-SHA256 and return the result as a lowercase hex string.
 *
 * This is the shared primitive used by webhook verification, callback
 * signing, and internal token generation across all Open-Inspect services.
 *
 * @param data - The data to sign
 * @param secret - The HMAC secret key
 * @returns 64-character lowercase hex string
 */
export async function computeHmacHex(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Generate an internal API token for CP→Modal endpoint calls (the
 * MODAL_API_SECRET mechanism — separate from sig1 service auth).
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
  const signatureHex = await computeHmacHex(timestamp, secret);
  return `${timestamp}.${signatureHex}`;
}

/**
 * Verify the HMAC body signature on a CP→bot callback payload.
 * Prevents external callers from forging completion callbacks.
 */
export async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

/**
 * Verify a CP→bot callback against the bot's own per-service secret
 * (the CP signs callbacks with the destination bot's key).
 */
export async function verifyCallbackFromControlPlane<T extends { signature: string }>(
  payload: T,
  env: { SERVICE_AUTH_SECRET?: string }
): Promise<boolean> {
  return Boolean(
    env.SERVICE_AUTH_SECRET && (await verifyCallbackSignature(payload, env.SERVICE_AUTH_SECRET))
  );
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
  const expectedHex = await computeHmacHex(timestamp, secret);
  return timingSafeEqual(signature, expectedHex);
}
