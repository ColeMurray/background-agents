import { createHash } from "node:crypto";
import { readBoundedBytes } from "@open-inspect/control-plane/src/http/bounded-body";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
  ObjectStoragePutValue,
} from "@open-inspect/control-plane/src/storage/object-storage";

/** Disposable bounded storage; deliberately not an S3/R2 emulator. */
export function createPreviewObjectStorage(maxBytes = 16 * 1024 * 1024): ObjectStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string; etag: string }>();
  let storedBytes = 0;
  const capacityExceeded = () => new Error("Preview object storage capacity exceeded");
  const metadata = (
    object: NonNullable<ReturnType<typeof objects.get>>
  ): ObjectStorageMetadata => ({
    size: object.bytes.byteLength,
    httpEtag: object.etag,
    writeHttpMetadata(headers) {
      if (object.contentType) headers.set("content-type", object.contentType);
    },
  });
  /** A private copy: callers may reuse their buffers after `put` returns. */
  async function copyBytes(value: ObjectStoragePutValue): Promise<Uint8Array> {
    if (value instanceof ReadableStream) {
      const result = await readBoundedBytes(value, maxBytes);
      if (!result.ok) throw capacityExceeded();
      return result.bytes;
    }
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    return new Uint8Array(value).slice();
  }
  return {
    async put(key, value, options) {
      const bytes = await copyBytes(value);
      const nextSize = storedBytes - (objects.get(key)?.bytes.byteLength ?? 0) + bytes.byteLength;
      if (nextSize > maxBytes) throw capacityExceeded();
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
      return { ...metadata(object), body: new Response(bytes).body! };
    },
  };
}
