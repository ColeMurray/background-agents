/**
 * Buffer a request/response body stream under a hard byte cap: returns the
 * concatenated bytes, an empty array for a missing body, or null once the cap
 * is exceeded (the stream is cancelled at that point). Callers turn the null
 * into their own too-large response.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
