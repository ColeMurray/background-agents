import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared";

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = signatureHeader.slice("sha256=".length);
  const computedHex = await computeHmacHex(rawBody, secret);

  return timingSafeEqual(expectedHex, computedHex);
}
