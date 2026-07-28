import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { UserStore } from "../db/user-store";
import type { Env } from "../types";
import { sessionWsTokenRoutes } from "./session-ws-token";
import type { RequestContext } from "./shared";

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn(),
}));

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
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

function getHandler() {
  const path = "/sessions/session-1/ws-token";
  const route = sessionWsTokenRoutes[0];
  const match = path.match(route.pattern);
  if (!match) throw new Error("Route did not match");
  return { handler: route.handler, match };
}

describe("session websocket token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: vi.fn().mockResolvedValue({
          id: "user-1",
          displayName: "Ada Lovelace",
          email: "ada@example.com",
        }),
      } as never;
    });
  });

  it("resolves the presence name from the canonical user profile", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ token: "token-1" });
    });
    const { handler, match } = getHandler();

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    await expect(requests[0].json()).resolves.toEqual({
      userId: "user-1",
      authName: "Ada Lovelace",
    });
  });

  it("rejects caller-supplied display metadata", async () => {
    const fetch = vi.fn(async () => Response.json({ token: "token-1" }));
    const { handler, match } = getHandler();

    const response = await handler(
      new Request("https://test.local/sessions/session-1/ws-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authName: "Impostor" }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
