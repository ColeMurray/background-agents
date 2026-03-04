import { describe, it, expect, vi } from "vitest";
import { R2MediaService } from "./r2-media-service";

function createMockBucket(): R2Bucket {
  const store = new Map<string, { body: ArrayBuffer; contentType: string }>();

  return {
    put: vi.fn(async (key: string, body: ArrayBuffer | ReadableStream, options?: R2PutOptions) => {
      const buf = body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
      store.set(key, {
        body: buf,
        contentType:
          (options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType ??
          "application/octet-stream",
      });
      return {} as R2Object;
    }),
    get: vi.fn(async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(item.body));
            controller.close();
          },
        }),
        httpMetadata: { contentType: item.contentType },
      } as unknown as R2ObjectBody;
    }),
    head: vi.fn(async (key: string) => {
      if (!store.has(key)) return null;
      return {} as R2Object;
    }),
  } as unknown as R2Bucket;
}

describe("R2MediaService", () => {
  describe("upload", () => {
    it("stores an object and returns the key", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      const key = await service.upload("test/file.png", new ArrayBuffer(100), "image/png");

      expect(key).toBe("test/file.png");
      expect(bucket.put).toHaveBeenCalledWith("test/file.png", expect.any(ArrayBuffer), {
        httpMetadata: { contentType: "image/png" },
      });
    });

    it("handles different content types", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      await service.upload("doc.pdf", new ArrayBuffer(50), "application/pdf");

      expect(bucket.put).toHaveBeenCalledWith("doc.pdf", expect.any(ArrayBuffer), {
        httpMetadata: { contentType: "application/pdf" },
      });
    });
  });

  describe("get", () => {
    it("returns body and content type for existing objects", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      await service.upload("img.png", new ArrayBuffer(64), "image/png");
      const result = await service.get("img.png");

      expect(result).not.toBeNull();
      expect(result!.contentType).toBe("image/png");
      expect(result!.body).toBeInstanceOf(ReadableStream);
    });

    it("returns null for non-existent objects", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      const result = await service.get("does-not-exist.png");

      expect(result).toBeNull();
    });

    it("defaults content type to application/octet-stream when missing", async () => {
      const bucket = createMockBucket();
      // Override get to return object without httpMetadata
      (bucket.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        body: new ReadableStream(),
        httpMetadata: undefined,
      });
      const service = new R2MediaService(bucket);

      const result = await service.get("no-metadata");

      expect(result!.contentType).toBe("application/octet-stream");
    });
  });

  describe("head", () => {
    it("returns true for existing objects", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      await service.upload("exists.txt", new ArrayBuffer(10), "text/plain");
      const exists = await service.head("exists.txt");

      expect(exists).toBe(true);
    });

    it("returns false for non-existent objects", async () => {
      const bucket = createMockBucket();
      const service = new R2MediaService(bucket);

      const exists = await service.head("nope.txt");

      expect(exists).toBe(false);
    });
  });
});
