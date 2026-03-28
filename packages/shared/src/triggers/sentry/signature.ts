/**
 * Verify Sentry webhook signatures (HMAC-SHA256).
 */

import { computeHmacHex, timingSafeEqual } from "../../auth";

export async function verifySentrySignature(
  body: string,
  signature: string | null | undefined,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const expected = await computeHmacHex(body, secret);
  return timingSafeEqual(expected, signature);
}
