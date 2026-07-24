import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import type { RequestContext } from "./shared";
import { sessionWsTokenRoutes } from "./session-ws-token";

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
  for (const route of sessionWsTokenRoutes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) return { handler: route.handler, match };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

describe("session ws-token route", () => {
  it("validates and forwards a valid token body", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ token: "ws-token" });
    });
    const { handler, match } = getHandler("POST", "/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmUserId: "scm-1",
          scmLogin: "octocat",
          scmName: "Octo Cat",
          authName: "Octo",
          scmEmail: "octo@example.com",
          scmToken: "gho-token",
          scmRefreshToken: "refresh-token",
          scmTokenExpiresAt: 2000,
        }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    await expect(response.json()).resolves.toEqual({ token: "ws-token" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.wsToken);
    await expect(requests[0].json()).resolves.toEqual({
      userId: "user-1",
      scmUserId: "scm-1",
      scmLogin: "octocat",
      scmName: "Octo Cat",
      authName: "Octo",
      scmEmail: "octo@example.com",
      scmTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: 2000,
    });
  });

  it("rejects malformed JSON without forwarding", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "ws-token" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/ws-token");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
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

  it("rejects partial or malformed token bodies without forwarding", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "ws-token" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/ws-token");

    for (const body of [
      { scmToken: "gho-token" },
      { userId: "user-1", scmTokenExpiresAt: "soon" },
    ]) {
      const response = await handler(
        new Request("https://test.local/sessions/session-1/ws-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        createEnv(fetch),
        match,
        createCtx()
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
