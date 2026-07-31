import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import type { Env } from "../types";

function createCtx(db: SqlDatabase = {} as SqlDatabase): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db,
    principal: {
      kind: "user",
      userId: "user-1",
    },
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

  it("returns deduplicated canonical participant profiles with safe fields only", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        participants: [
          { id: "p-1", userId: "user-1" },
          { id: "p-2", userId: "user-1" },
          { id: "p-3", userId: "deleted-user" },
          { id: "p-4", userId: "slack:U123", canonicalUserId: "user-bot" },
        ],
      })
    );
    const bind = vi.fn();
    const statement = { bind };
    bind.mockReturnValue(statement);
    const db = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => [
        {
          results: [
            {
              id: "user-1",
              display_name: "Ada Lovelace",
              email: "private@example.com",
              avatar_url: "https://avatars.example/ada",
              created_at: 1,
              updated_at: 2,
            },
            {
              id: "user-bot",
              display_name: "Build Bot",
              email: null,
              avatar_url: "https://avatars.example/bot",
              created_at: 1,
              updated_at: 2,
            },
          ],
          meta: { changes: 0 },
        },
      ]),
    } as unknown as SqlDatabase;
    const { handler, match } = getHandler("GET", "/sessions/session-1/participant-profiles");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch),
      match,
      createCtx(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: {
        "user-1": {
          userId: "user-1",
          displayName: "Ada Lovelace",
          avatarUrl: "https://avatars.example/ada",
        },
        "user-bot": {
          userId: "user-bot",
          displayName: "Build Bot",
          avatarUrl: "https://avatars.example/bot",
        },
      },
    });
    expect(bind).toHaveBeenCalledWith("user-1", "deleted-user", "user-bot");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves participant runtime errors without querying profiles", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "missing" }, { status: 404 }));
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as SqlDatabase;
    const { handler, match } = getHandler("GET", "/sessions/session-1/participant-profiles");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch),
      match,
      createCtx(db)
    );

    expect(response.status).toBe(404);
    expect(db.prepare).not.toHaveBeenCalled();
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
        body: JSON.stringify({ title: "New title" }),
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

  it("rejects a caller-asserted title-update userId without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "updated" }));
    const { handler, match } = getHandler("PATCH", "/sessions/session-1/title");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "someone-else", title: "New title" }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'userId' is not accepted from verified callers",
    });
    expect(fetch).not.toHaveBeenCalled();
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

  it("forwards the create-PR repo target to the runtime", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ prNumber: 7 });
    });
    const { handler, match } = getHandler("POST", "/sessions/session-1/pr");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "PR",
          body: "desc",
          baseBranch: "main",
          headBranch: "feature/x",
          repoOwner: "acme",
          repoName: "backend",
        }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.createPr);
    await expect(requests[0].json()).resolves.toEqual({
      title: "PR",
      body: "desc",
      baseBranch: "main",
      headBranch: "feature/x",
      repoOwner: "acme",
      repoName: "backend",
    });
  });

  it("rejects a non-string create-PR repo target without forwarding", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { handler, match } = getHandler("POST", "/sessions/session-1/pr");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc", repoOwner: 42, repoName: "backend" }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "repoOwner must be a string" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
