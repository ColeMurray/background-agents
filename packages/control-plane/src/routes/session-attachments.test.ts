import { describe, expect, it, vi } from "vitest";
import { SESSION_ATTACHMENT_MAX_REQUEST_BYTES } from "../media";
import type { Env } from "../types";
import { sessionAttachmentRoutes } from "./session-attachments";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(fetch: (request: Request) => Promise<Response>) {
  const put = vi.fn(async () => null);
  const remove = vi.fn(async () => undefined);
  const env = {
    SESSION: {
      idFromName: vi.fn((name: string) => `do-${name}`),
      get: vi.fn(() => ({ fetch })),
    },
    MEDIA_BUCKET: {
      put,
      delete: remove,
      head: vi.fn(),
      get: vi.fn(),
    },
  } as unknown as Env;
  return { env, put, remove };
}

function attachmentUploadRequest(): Request {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "image.png", { type: "image/png" }));
  return new Request("https://test.local/sessions/session-1/attachments", {
    method: "POST",
    body: form,
  });
}

function oversizedStreamingUploadRequest(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1));
      controller.close();
    },
  });
  return new Request("https://test.local/sessions/session-1/attachments", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function getUploadRoute() {
  const path = "/sessions/session-1/attachments";
  const route = sessionAttachmentRoutes.find(
    (candidate) => candidate.method === "POST" && path.match(candidate.pattern)
  );
  if (!route) throw new Error("Attachment upload route not found");
  const match = path.match(route.pattern);
  if (!match) throw new Error("Attachment upload route did not match");
  return { route, match };
}

describe("session attachment routes", () => {
  it("bounds streamed requests when Content-Length is unavailable", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { env, put } = createEnv(fetch);
    const { route, match } = getUploadRoute();

    const response = await route.handler(
      oversizedStreamingUploadRequest(),
      env,
      match,
      createContext()
    );

    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [404, "Session not found", 404],
    [429, "Quota exceeded", 429],
    [500, "Registry failed", 502],
  ])(
    "maps attachment service failures to route responses: %s -> %s",
    async (registryStatus, message, routeStatus) => {
      const fetch = vi.fn(async () =>
        Response.json({ error: message }, { status: registryStatus })
      );
      const { env, put } = createEnv(fetch);
      const { route, match } = getUploadRoute();

      const response = await route.handler(attachmentUploadRequest(), env, match, createContext());

      expect(response.status).toBe(routeStatus);
      await expect(response.json()).resolves.toEqual({ error: message });
      expect(put).not.toHaveBeenCalled();
    }
  );

  it("maps cleanup failures to a service-unavailable response", async () => {
    const responses = [
      Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: 1000,
        staleAttachments: [
          { attachmentId: "old-1", objectKey: "sessions/session-1/attachments/old-1" },
        ],
      }),
      Response.json({ status: "ok" }),
    ];
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Missing test response");
      return response;
    });
    const { env, put, remove } = createEnv(fetch);
    remove.mockRejectedValue(new Error("R2 unavailable"));
    const { route, match } = getUploadRoute();

    const response = await route.handler(attachmentUploadRequest(), env, match, createContext());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to clean up expired attachments; please retry",
    });
    expect(put).not.toHaveBeenCalled();
  });
});
