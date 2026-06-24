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

  it("only rewrites runtime 404 responses to the configured not-found response", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "runtime failed" }, { status: 500 }));
    const { handler, match } = getHandler("GET", "/sessions/session-1");

    const response = await handler(
      new Request("https://test.local/sessions/session-1"),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "runtime failed" });
  });

  it("maps runtime 404 responses to the configured not-found response", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "missing" }, { status: 404 }));
    const { handler, match } = getHandler("GET", "/sessions/session-1");

    const response = await handler(
      new Request("https://test.local/sessions/session-1"),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  it("rejects malformed add-participant JSON without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/participants");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the draft flag through the create-PR contract", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ prNumber: 1, prUrl: "https://example/pr/1", state: "draft" });
    });
    const { handler, match } = getHandler("POST", "/sessions/session-1/pr");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "T", body: "B", draft: true }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.createPr);
    await expect(requests[0].json()).resolves.toMatchObject({ title: "T", body: "B", draft: true });
  });

  it("rejects a non-boolean draft without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/pr");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "T", body: "B", draft: "yes" }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "draft must be a boolean" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed create-PR JSON without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/pr");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
