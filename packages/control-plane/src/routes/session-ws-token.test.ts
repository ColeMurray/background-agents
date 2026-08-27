import { describe, expect, it, vi } from "vitest";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import { sessionWsTokenRoutes } from "./session-ws-token";
import type { RequestContext, Route } from "./shared";
import type { Env } from "../types";

function routeFor(path: string): { route: Route; match: RegExpMatchArray } {
  const route = sessionWsTokenRoutes.find((candidate) => candidate.pattern.test(path));
  if (!route) throw new Error(`route not found: ${path}`);
  const match = path.match(route.pattern);
  if (!match) throw new Error(`path did not match: ${path}`);
  return { route, match };
}

function createContext(): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    db: {} as never,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    principal: { kind: "user", userId: "user-1" },
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

describe("session ws-token route", () => {
  it("forwards validated optional SCM display fields", async () => {
    const forwarded: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ token: "token-1" });
    });
    const { route, match } = routeFor("/sessions/session-1/ws-token");

    const response = await route.handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({
          scmLogin: "octocat",
          scmName: "Octo Cat",
          scmEmail: "octo@example.com",
        }),
      }),
      createEnv(fetch),
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(forwarded[0].json()).resolves.toMatchObject({
      userId: "user-1",
      canonicalUserId: "user-1",
      scmLogin: "octocat",
      scmName: "Octo Cat",
      scmEmail: "octo@example.com",
    });
  });

  it("forwards null SCM display fields accepted by the session contract", async () => {
    const forwarded: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ token: "token-1" });
    });
    const { route, match } = routeFor("/sessions/session-1/ws-token");

    const response = await route.handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ scmLogin: null, scmName: null, scmEmail: null }),
      }),
      createEnv(fetch),
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(forwarded[0].json()).resolves.toMatchObject({
      scmLogin: null,
      scmName: null,
      scmEmail: null,
    });
  });

  it("rejects malformed optional SCM display fields", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "token-1" }));
    const { route, match } = routeFor("/sessions/session-1/ws-token");

    const response = await route.handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ scmLogin: 123 }),
      }),
      createEnv(fetch),
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid websocket token body" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still rejects forbidden identity fields before schema stripping", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "token-1" }));
    const { route, match } = routeFor("/sessions/session-1/ws-token");

    const response = await route.handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        body: JSON.stringify({ userId: "attacker" }),
      }),
      createEnv(fetch),
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'userId' is not accepted from verified callers",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
