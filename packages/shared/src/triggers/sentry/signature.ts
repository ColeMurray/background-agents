/**
 * Verify Sentry webhook signatures (HMAC-SHA256).
 */

import { timingSafeEqual } from "../../auth";

export async function verifySentrySignature(
  body: string,
  signature: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature);
}
