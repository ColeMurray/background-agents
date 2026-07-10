import { describe, expect, it, vi } from "vitest";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
  ObjectStorageObject,
} from "../storage/object-storage";
import { streamStoredMedia } from "./stream-stored-media";

function metadata(contentType = "image/png"): ObjectStorageMetadata {
  return {
    size: 10,
    httpEtag: '"etag"',
    writeHttpMetadata(headers) {
      headers.set("Content-Type", contentType);
    },
  };
}

function object(contentType = "image/png"): ObjectStorageObject {
  return {
    ...metadata(contentType),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  };
}

function storage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    put: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(async () => metadata()),
    get: vi.fn(async () => object()),
    ...overrides,
  };
}

function options(request: Request, mediaStorage: ObjectStorage) {
  return {
    request,
    storage: mediaStorage,
    objectKey: "objects/media",
    isAllowedContentType: (contentType: string) => contentType === "image/png",
    notFound: () => Response.json({ error: "missing" }, { status: 404 }),
    invalidMetadata: () => Response.json({ error: "invalid" }, { status: 500 }),
  };
}

describe("streamStoredMedia", () => {
  it("streams a full object with canonical headers", async () => {
    const response = await streamStoredMedia(
      options(new Request("https://example.test"), storage())
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe("10");
  });

  it("uses the same flow for byte ranges", async () => {
    const mediaStorage = storage();
    const response = await streamStoredMedia(
      options(
        new Request("https://example.test", { headers: { Range: "bytes=2-5" } }),
        mediaStorage
      )
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(mediaStorage.get).toHaveBeenCalledWith("objects/media", {
      range: { offset: 2, length: 4 },
    });
  });

  it("rejects disallowed stored metadata", async () => {
    const mediaStorage = storage({ get: vi.fn(async () => object("application/octet-stream")) });
    const response = await streamStoredMedia(
      options(new Request("https://example.test"), mediaStorage)
    );

    expect(response.status).toBe(500);
  });
});
