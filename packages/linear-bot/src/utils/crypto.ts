/**
 * Re-export shared HMAC-SHA256 primitive.
 *
 * The canonical implementation lives in @open-inspect/shared.
 * This module re-exports it for backward compatibility with existing imports.
 */

import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared";

export { computeHmacHex };

export async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}
