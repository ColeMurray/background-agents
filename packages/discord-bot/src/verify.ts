/**
 * Discord interaction signature verification.
 *
 * Discord signs `timestamp + rawBody` with the application's Ed25519 key and
 * sends the signature and timestamp as headers. Endpoints that fail to reject
 * a bad signature are disabled by Discord, so every request is checked.
 * Stale timestamps are rejected too, so a captured request cannot be replayed
 * to start another task.
 */

/** How far a signed timestamp may drift from now before the request is refused. */
export const MAX_SIGNATURE_SKEW_MS = 5 * 60 * 1000;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordSignature(params: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  nowMs?: number;
}): Promise<boolean> {
  const { publicKey, signature, timestamp, body } = params;
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const skewMs = Math.abs((params.nowMs ?? Date.now()) - Number(timestamp) * 1000);
  if (skewMs > MAX_SIGNATURE_SKEW_MS) return false;

  const keyBytes = hexToBytes(publicKey);
  const signatureBytes = hexToBytes(signature);
  if (!keyBytes || keyBytes.length !== 32 || !signatureBytes || signatureBytes.length !== 64) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}
