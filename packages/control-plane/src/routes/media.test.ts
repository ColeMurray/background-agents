import { describe, it, expect, vi } from "vitest";
import { mediaRoutes } from "./media";
import type { Env } from "../types";
import type { RequestContext } from "./shared";

function createMockEnv(overrides?: Partial<Env>): Env {
  const store = new Map<string, { body: ArrayBuffer; contentType: string }>();
  return {
    MEDIA_BUCKET: {
      put: vi.fn(async (key: string, body: ArrayBuffer, options?: R2PutOptions) => {
        store.set(key, {
          body,
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
      head: vi.fn(async (key: string) => (store.has(key) ? ({} as R2Object) : null)),
    } as unknown as R2Bucket,
    WORKER_URL: "https://test.workers.dev",
    ...overrides,
  } as unknown as Env;
}

function createCtx(): RequestContext {
  return { request_id: "test-req-1", metrics: {} as RequestContext["metrics"] };
}

function findRoute(method: string, path: string) {
  return mediaRoutes.find((r) => r.method === method && r.pattern.test(path));
}

describe("media routes", () => {
  describe("POST /api/media/upload", () => {
    it("uploads a file and returns key + url", async () => {
      const env = createMockEnv();
      const route = findRoute("POST", "/api/media/upload")!;
      expect(route).toBeDefined();

      const body = new ArrayBuffer(100);
      const request = new Request("https://test.local/api/media/upload", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "x-filename": "screenshot.png",
          "x-session-id": "sess-123",
        },
        body,
      });

      const match = "/api/media/upload".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(201);
      const data = await response.json<{ key: string; url: string }>();
      expect(data.key).toMatch(/^sess-123\/.+\.png$/);
      expect(data.url).toContain("https://test.workers.dev/api/media/");
    });

    it("rejects files exceeding 10 MB via content-length", async () => {
      const env = createMockEnv();
      const route = findRoute("POST", "/api/media/upload")!;

      const request = new Request("https://test.local/api/media/upload", {
        method: "POST",
        headers: {
          "content-type": "image/png",
          "content-length": String(11 * 1024 * 1024),
        },
        body: new ArrayBuffer(0),
      });

      const match = "/api/media/upload".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(413);
    });

    it("returns 503 when MEDIA_BUCKET is not configured", async () => {
      const env = createMockEnv({ MEDIA_BUCKET: undefined } as unknown as Partial<Env>);
      const route = findRoute("POST", "/api/media/upload")!;

      const request = new Request("https://test.local/api/media/upload", {
        method: "POST",
        body: new ArrayBuffer(10),
      });

      const match = "/api/media/upload".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(503);
    });

    it("generates key without session prefix when no x-session-id header", async () => {
      const env = createMockEnv();
      const route = findRoute("POST", "/api/media/upload")!;

      const request = new Request("https://test.local/api/media/upload", {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-filename": "report.pdf" },
        body: new ArrayBuffer(50),
      });

      const match = "/api/media/upload".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(201);
      const data = await response.json<{ key: string }>();
      // No session prefix — key is just uuid.ext
      expect(data.key).not.toContain("/");
      // Should use .pdf extension from mime type
      expect(data.key).toMatch(/\.pdf$/);
    });
  });

  describe("GET /api/media/:key", () => {
    it("returns the stored object with correct content type", async () => {
      const env = createMockEnv();
      const uploadRoute = findRoute("POST", "/api/media/upload")!;
      const downloadRoute = findRoute("GET", "/api/media/test-key")!;
      expect(downloadRoute).toBeDefined();

      // Upload first
      const uploadReq = new Request("https://test.local/api/media/upload", {
        method: "POST",
        headers: { "content-type": "image/png", "x-filename": "test.png" },
        body: new ArrayBuffer(64),
      });
      const uploadMatch = "/api/media/upload".match(uploadRoute.pattern)!;
      const uploadResp = await uploadRoute.handler(uploadReq, env, uploadMatch, createCtx());
      const { key } = await uploadResp.json<{ key: string }>();

      // Download
      const downloadReq = new Request(`https://test.local/api/media/${key}`);
      const downloadMatch = `/api/media/${key}`.match(downloadRoute.pattern)!;
      const response = await downloadRoute.handler(downloadReq, env, downloadMatch, createCtx());

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, immutable");
    });

    it("returns 404 for non-existent key", async () => {
      const env = createMockEnv();
      const route = findRoute("GET", "/api/media/missing-key")!;

      const request = new Request("https://test.local/api/media/missing-key");
      const match = "/api/media/missing-key".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(404);
    });

    it("returns 503 when MEDIA_BUCKET is not configured", async () => {
      const env = createMockEnv({ MEDIA_BUCKET: undefined } as unknown as Partial<Env>);
      const route = findRoute("GET", "/api/media/some-key")!;

      const request = new Request("https://test.local/api/media/some-key");
      const match = "/api/media/some-key".match(route.pattern)!;
      const response = await route.handler(request, env, match, createCtx());

      expect(response.status).toBe(503);
    });
  });
});
