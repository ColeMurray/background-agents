import { describe, expect, it, vi } from "vitest";
import { SessionInternalPaths } from "../session/contracts";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";
import type { Env } from "../types";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

function createCtx(db: SqlDatabase = {} as SqlDatabase): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
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
    if (match) return { handler: route.handler, match, route };
  }
  throw new Error(`No route found for ${method} ${path}`);
}

describe("session runtime proxy routes", () => {
  it.each([
    ["snapshot", "/sessions/session-1", SessionInternalPaths.snapshot],
    ["sandbox access", "/sessions/session-1/sandbox-access", SessionInternalPaths.sandboxAccess],
  ])("forwards %s for users", async (_name, path, internalPath) => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ sessionId: "session-1" });
    });
    const { handler, match } = getHandler("GET", path);

    const response = await handler(
      new Request(`https://test.local${path}`),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(new URL(requests[0].url).pathname).toBe(internalPath);
    expect(fetch).toHaveBeenCalledOnce();
  });

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

  it("forwards sandbox fatal errors to the session runtime", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ status: "ok" });
    });
    const path = "/sessions/session-1/sandbox-error";
    const { handler, match, route } = getHandler("POST", path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify({ error: "Bridge repeatedly crashed", fatal: true }),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    expect(route.authentication.kind).toBe("handler-authenticated");
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.sandboxError);
    expect(requests[0].headers.get("Authorization")).toBe("Bearer sandbox-token");
    expect(requests[0].headers.get("X-Sandbox-ID")).toBe("sandbox-1");
    await expect(requests[0].json()).resolves.toEqual({
      error: "Bridge repeatedly crashed",
      fatal: true,
    });
  });

  it("rejects oversized sandbox errors before forwarding them", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const path = "/sessions/session-1/sandbox-error";
    const { handler, match } = getHandler("POST", path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: "x".repeat(2049),
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects missing sandbox credentials before reading or forwarding the body", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const path = "/sessions/session-1/sandbox-error";
    const { handler, match } = getHandler("POST", path);

    const response = await handler(
      new Request(`https://test.local${path}`, { method: "POST", body: "not json" }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty sandbox error before forwarding it", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const path = "/sessions/session-1/sandbox-error";
    const { handler, match } = getHandler("POST", path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
      }),
      createEnv(fetch),
      match,
      createCtx()
    );

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns deduplicated canonical participant profiles with safe fields only", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        participants: [
          { id: "p-1", userId: "user-1" },
          { id: "p-2", userId: "user-1" },
          { id: "p-3", userId: "deleted-user" },
          { id: "p-4", userId: "slack:U123", canonicalUserId: "user-bot" },
          { id: "p-5", userId: "user-2", canonicalUserId: null },
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
            {
              id: "user-2",
              display_name: "Grace Hopper",
              email: null,
              avatar_url: null,
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
        "user-2": {
          userId: "user-2",
          displayName: "Grace Hopper",
          avatarUrl: null,
        },
      },
    });
    expect(bind).toHaveBeenCalledWith("user-1", "deleted-user", "user-bot", "user-2");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns a bad-gateway error for malformed participant responses", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ participants: [{ canonicalUserId: "user-1" }] })
    );
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as SqlDatabase;
    const { handler, match } = getHandler("GET", "/sessions/session-1/participant-profiles");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch),
      match,
      createCtx(db)
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid participant response" });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("returns a bad-gateway error when the participant response is not JSON", async () => {
    const fetch = vi.fn(async () => new Response("not json", { status: 200 }));
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as SqlDatabase;
    const { handler, match } = getHandler("GET", "/sessions/session-1/participant-profiles");

    const response = await handler(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch),
      match,
      createCtx(db)
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid participant response" });
    expect(db.prepare).not.toHaveBeenCalled();
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

  it("forwards the verified service actor on title updates", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ status: "updated" });
    });
    const { handler, match } = getHandler("PATCH", "/sessions/session-1/title");
    const ctx = createCtx();
    ctx.principal = {
      kind: "service",
      service: "slack-bot",
      actor: {
        provider: "slack",
        providerUserId: "U0123",
        canonicalUserId: "user-1",
        participantUserId: "slack:U0123",
      },
    };

    const response = await handler(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      }),
      createEnv(fetch),
      match,
      ctx
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(requests[0].json()).resolves.toEqual({
      userId: "slack:U0123",
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
