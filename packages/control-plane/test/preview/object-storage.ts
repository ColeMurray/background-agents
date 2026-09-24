import { createHash } from "node:crypto";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
  ObjectStoragePutValue,
} from "../../src/storage/object-storage";

/** Disposable bounded storage; deliberately not an S3/R2 emulator. */
export function createPreviewObjectStorage(maxBytes = 16 * 1024 * 1024): ObjectStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string; etag: string }>();
  let storedBytes = 0;
  const metadata = (
    object: NonNullable<ReturnType<typeof objects.get>>
  ): ObjectStorageMetadata => ({
    size: object.bytes.byteLength,
    httpEtag: object.etag,
    writeHttpMetadata(headers) {
      if (object.contentType) headers.set("content-type", object.contentType);
    },
  });
  async function read(value: ObjectStoragePutValue): Promise<Uint8Array> {
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (!(chunk instanceof Uint8Array)) throw new TypeError("Expected byte stream");
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error("Preview object storage capacity exceeded");
          chunks.push(chunk.slice());
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    }
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    return new Uint8Array(value).slice();
  }
  return {
    async put(key, value, options) {
      const bytes = await read(value);
      const nextSize = storedBytes - (objects.get(key)?.bytes.byteLength ?? 0) + bytes.byteLength;
      if (nextSize > maxBytes) throw new Error("Preview object storage capacity exceeded");
      objects.set(key, {
        bytes,
        contentType: options?.contentType,
        etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      });
      storedBytes = nextSize;
    },
    async delete(key) {
      storedBytes -= objects.get(key)?.bytes.byteLength ?? 0;
      objects.delete(key);
    },
    async head(key) {
      const object = objects.get(key);
      return object ? metadata(object) : null;
    },
    async get(key, options) {
      const object = objects.get(key);
      if (!object) return null;
      const range = options?.range;
      if (
        range &&
        (!Number.isInteger(range.offset) ||
          !Number.isInteger(range.length) ||
          range.offset < 0 ||
          range.length < 0)
      )
        throw new Error("Invalid storage range");
      const bytes = range
        ? object.bytes.slice(range.offset, range.offset + range.length)
        : object.bytes.slice();
      return {
        ...metadata(object),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
  };
}
