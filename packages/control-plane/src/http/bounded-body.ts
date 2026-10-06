export type BoundedBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; byteLength: number };

/** Read a byte stream without retaining more than the caller's budget. */
export async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  declaredLength?: string | null
): Promise<BoundedBytesResult> {
  const declared =
    declaredLength === null || declaredLength === undefined ? null : Number(declaredLength);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    await stream?.cancel().catch(() => undefined);
    return { ok: false, byteLength: declared };
  }
  if (!stream) return { ok: true, bytes: new Uint8Array() };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, byteLength };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
