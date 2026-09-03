import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import {
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { sessionRuntimeProxyRoutes } from "./session-runtime-proxy";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

const handleRequest = createTestRequestHandler([sessionRuntimeProxyRoutes]);

const USER: Principal = { kind: "user", userId: "user-1" };
const JSON_HEADERS = { "Content-Type": "application/json" };
const SANDBOX_HEADERS = { Authorization: "Bearer sandbox-token", "X-Sandbox-ID": "sandbox-1" };
/** Sandbox-authenticated routes verify the bearer token against the runtime before proxying. */
const SANDBOX_TOKEN_HEADERS = { Authorization: "Bearer sandbox-token" };

type DatabaseOptions = {
  /** Custom-role grants for user-1; omitted means the owner role with every permission. */
  permissions?: PermissionId[];
  /** Answers every statement admission and the proxy's own reads do not own. */
  delegate?: SqlDatabase;
};

/**
 * A database that answers admission's role lookup and the token-refresh
 * binding read, handing anything else to the test's delegate.
 */
function createDatabase(options: DatabaseOptions = {}): SqlDatabase {
  const role = options.permissions
    ? { role_id: "role-1", role_key: null, role_name: "Viewer" }
    : { role_id: BUILT_IN_ROLE_REGISTRY.owner.id, role_key: "owner", role_name: "Owner" };
  const rows = (sql: string): unknown[] | null => {
    if (sql.includes("FROM role_permissions")) {
      return (options.permissions ?? []).map((permission_id) => ({ permission_id }));
    }
    return null;
  };
  const row = (sql: string): unknown => {
    if (sql.includes("FROM users u")) return { user_id: "user-1", suspended_at: null, ...role };
    if (sql.includes("FROM session_model_provider_auth")) {
      return {
        provider: "openai",
        auth_mode: "legacy_scoped_oauth",
        provider_account_id: null,
        selection_source: "explicit",
      };
    }
    return null;
  };
  return {
    prepare(sql: string) {
      const owned = rows(sql) !== null || row(sql) !== null;
      if (!owned && options.delegate) return options.delegate.prepare(sql);
      const statement: SqlStatement = {
        bind: () => statement,
        first: async <T>() => row(sql) as T | null,
        all: async <T>() => ({ results: (rows(sql) ?? []) as T[], meta: { changes: 0 } }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async (statements) => (options.delegate ? options.delegate.batch(statements) : []),
  };
}

function createEnv(
  fetch: (request: Request) => Promise<Response>,
  database: DatabaseOptions = {}
): Env {
  return {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    DB: createDatabase(database),
    SESSION: {
      idFromName: vi.fn((name: string) => `do-${name}`),
      get: vi.fn(() => ({ fetch })),
    },
  } as unknown as Env;
}

function dispatch(request: Request, env: Env): Promise<Response> {
  return handleRequest(request, env, TEST_BACKGROUND_TASK_CONTEXT);
}

function authenticateAs(principal: Principal): void {
  mocks.authenticate.mockImplementation(async (request: Request) => ({ principal, request }));
}

describe("session runtime proxy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAs(USER);
  });

  it.each([
    { method: "GET", path: "/sessions/session-1/sandbox-access", internal: "sandboxAccess" },
    { method: "GET", path: "/sessions/session-1", internal: "snapshot", status: 502 },
    { method: "POST", path: "/sessions/session-1/stop", internal: "stop" },
    {
      method: "POST",
      path: "/sessions/session-1/sandbox-error",
      internal: "sandboxError",
      init: { headers: SANDBOX_HEADERS, body: JSON.stringify({ error: "crash", fatal: true }) },
    },
    { method: "GET", path: "/sessions/session-1/events", internal: "events" },
    { method: "GET", path: "/sessions/session-1/artifacts", internal: "artifacts" },
    { method: "GET", path: "/sessions/session-1/participants", internal: "participants" },
    {
      method: "GET",
      path: "/sessions/session-1/participant-profiles",
      internal: "participants",
      status: 502,
    },
    { method: "GET", path: "/sessions/session-1/messages", internal: "messages" },
    {
      method: "POST",
      path: "/sessions/session-1/pr",
      internal: "createPr",
      init: { headers: JSON_HEADERS, body: JSON.stringify({ title: "T", body: "B" }) },
    },
    {
      method: "POST",
      path: "/sessions/session-1/openai-token-refresh",
      internal: "openaiTokenRefresh",
      init: { headers: SANDBOX_TOKEN_HEADERS },
      sandbox: true,
    },
    {
      method: "POST",
      path: "/sessions/session-1/xai-token-refresh",
      internal: "xaiTokenRefresh",
      init: { headers: SANDBOX_TOKEN_HEADERS },
      sandbox: true,
    },
    {
      method: "POST",
      path: "/sessions/session-1/scm-credentials",
      internal: "scmCredentials",
      init: { headers: SANDBOX_TOKEN_HEADERS },
      sandbox: true,
    },
    { method: "GET", path: "/sessions/session-1/tunnel-urls", internal: "tunnelUrls" },
    {
      method: "PATCH",
      path: "/sessions/session-1/title",
      internal: "updateTitle",
      init: { headers: JSON_HEADERS, body: JSON.stringify({ title: "New title" }) },
    },
    { method: "POST", path: "/sessions/session-1/archive", internal: "archive" },
    { method: "POST", path: "/sessions/session-1/unarchive", internal: "unarchive" },
  ] as const)(
    "routes $method $path to the runtime's $internal path",
    async ({ method, path, internal, ...options }) => {
      const paths: string[] = [];
      const fetch = vi.fn(async (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return Response.json({ ok: true });
      });
      const init = "init" in options ? options.init : {};

      const response = await dispatch(
        new Request(`https://test.local${path}`, { method, ...init }),
        createEnv(fetch)
      );

      // A handler that parses the runtime's answer rejects this stub body;
      // the route is still proven to reach the expected internal path.
      expect(response.status).toBe("status" in options ? options.status : 200);
      const verified = "sandbox" in options ? [SessionInternalPaths.verifySandboxToken] : [];
      expect(paths).toEqual([...verified, SessionInternalPaths[internal]]);
    }
  );

  it("forwards sandbox access for users", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ sessionId: "session-1" });
    });

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/sandbox-access"),
      createEnv(fetch)
    );

    expect(response.status).toBe(200);
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.sandboxAccess);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { permissions: ["sessions.read"] as PermissionId[], exposed: false },
    {
      permissions: ["sessions.read", "sessions.sandbox_access"] as PermissionId[],
      exposed: true,
    },
  ])("scopes snapshot sandbox locations to sandbox access ($exposed)", async (input) => {
    const fetch = vi.fn(async () =>
      Response.json({
        session: {
          id: "session-1",
          title: "Session",
          repoOwner: "acme",
          repoName: "web",
          baseBranch: "main",
          branchName: "feature",
          status: "active",
          sandboxStatus: "ready",
          messageCount: 0,
          createdAt: 1,
          codeServerUrl: "https://code.example",
          vncUrl: "https://vnc.example",
          ttydUrl: "https://terminal.example",
          tunnelUrls: { "3000": "https://app.example" },
          sandboxDashboardUrl: "https://provider.example",
        },
        artifacts: [],
        promptQueue: [],
        timeline: { events: [], hasMore: false, cursor: null },
      })
    );

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1"),
      createEnv(fetch, { permissions: input.permissions })
    );
    const snapshot = (await response.json()) as { session: Record<string, unknown> };

    expect(response.status).toBe(200);
    if (input.exposed) {
      expect(snapshot.session).toHaveProperty("codeServerUrl", "https://code.example");
    } else {
      expect(snapshot.session).not.toHaveProperty("codeServerUrl");
      expect(snapshot.session).not.toHaveProperty("vncUrl");
      expect(snapshot.session).not.toHaveProperty("ttydUrl");
      expect(snapshot.session).not.toHaveProperty("tunnelUrls");
      expect(snapshot.session).not.toHaveProperty("sandboxDashboardUrl");
    }
  });

  it("forwards event query strings through the session runtime dependency", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ events: [] });
    });

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/events?limit=10"),
      createEnv(fetch)
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/sandbox-error", {
        method: "POST",
        headers: { "content-type": "application/json", ...SANDBOX_HEADERS },
        body: JSON.stringify({ error: "Bridge repeatedly crashed", fatal: true }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(200);
    // The route authenticates the sandbox itself; admission never asks.
    expect(mocks.authenticate).not.toHaveBeenCalled();
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/sandbox-error", {
        method: "POST",
        headers: SANDBOX_HEADERS,
        body: "x".repeat(2049),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects missing sandbox credentials before reading or forwarding the body", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/sandbox-error", {
        method: "POST",
        body: "not json",
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an empty sandbox error before forwarding it", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/sandbox-error", {
        method: "POST",
        headers: SANDBOX_HEADERS,
      }),
      createEnv(fetch)
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch, { delegate: db })
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch, { delegate: db })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid participant response" });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("returns a bad-gateway error when the participant response is not JSON", async () => {
    const fetch = vi.fn(async () => new Response("not json", { status: 200 }));
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as SqlDatabase;

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch, { delegate: db })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Invalid participant response" });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("preserves participant runtime errors without querying profiles", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "missing" }, { status: 404 }));
    const db = { prepare: vi.fn(), batch: vi.fn() } as unknown as SqlDatabase;

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/participant-profiles"),
      createEnv(fetch, { delegate: db })
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "New title" }),
      }),
      createEnv(fetch)
    );

    await expect(response.json()).resolves.toEqual({ status: "updated" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(requests[0].method).toBe("POST");
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.updateTitle);
    await expect(requests[0].json()).resolves.toEqual({
      title: "New title",
    });
  });

  it("does not forward service actor identity on title updates", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ status: "updated" });
    });
    authenticateAs({
      kind: "service",
      service: "slack-bot",
      actor: {
        provider: "slack",
        providerUserId: "U0123",
        canonicalUserId: "user-1",
        participantUserId: "slack:U0123",
      },
    });

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "New title" }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(requests[0].json()).resolves.toEqual({
      title: "New title",
    });
  });

  it("rejects a caller-asserted title-update userId without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "updated" }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/title", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ userId: "someone-else", title: "New title" }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'userId' is not accepted from verified callers",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("only rewrites runtime 404 responses to the configured not-found response", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "runtime failed" }, { status: 500 }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1"),
      createEnv(fetch)
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "runtime failed" });
  });

  it("maps runtime 404 responses to the configured not-found response", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "missing" }, { status: 404 }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1"),
      createEnv(fetch)
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
  });

  it("forwards the draft flag through the create-PR contract", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ prNumber: 1, prUrl: "https://example/pr/1", state: "draft" });
    });

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "T", body: "B", draft: true }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(requests[0].url).pathname).toBe(SessionInternalPaths.createPr);
    await expect(requests[0].json()).resolves.toMatchObject({ title: "T", body: "B", draft: true });
  });

  it("rejects a non-boolean draft without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "T", body: "B", draft: "yes" }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "draft must be a boolean" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed create-PR JSON without forwarding to the runtime", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{",
      }),
      createEnv(fetch)
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          title: "PR",
          body: "desc",
          baseBranch: "main",
          headBranch: "feature/x",
          repoOwner: "acme",
          repoName: "backend",
        }),
      }),
      createEnv(fetch)
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

    const response = await dispatch(
      new Request("https://test.local/sessions/session-1/pr", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title: "PR", body: "desc", repoOwner: 42, repoName: "backend" }),
      }),
      createEnv(fetch)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "repoOwner must be a string" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
