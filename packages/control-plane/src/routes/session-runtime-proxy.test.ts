import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import type { RequestContext } from "./shared";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import type { Env } from "../types";

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(fetch: (request: Request) => Promise<Response>): Env {
  return {
    SESSION: {
      idFromName: vi.fn((name: string) => `do-${name}`),
      get: vi.fn(() => ({ fetch })),
    },
  } as unknown as Env;
}

function getHandler(method: string, path: string) {
  for (const route of sessionRuntimeProxyRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

describe("session runtime proxy routes", () => {
  it("forwards event query strings through the session runtime dependency", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ events: [] });
    });
    const { handler, match } = getHandler("GET", "/sessions/session-1/events");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/events?limit=10"),
      createEnv(fetch),
      match,
      createCtx()
    );

    await expect(response.json()).resolves.toEqual({ events: [] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(requests[0].url).search).toBe("?limit=10");
  });

  it("adapts title updates to the internal runtime contract", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ status: "updated" });
    });
    const { handler, match } = getHandler("PATCH", "/sessions/session-1/title");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "New title" }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    await expect(response.json()).resolves.toEqual({ status: "updated" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests[0].method).toBe("POST");
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.updateTitle);
    await expect(requests[0].json()).resolves.toEqual({
      userId: "user-1",
      title: "New title",
    });
  });
});
