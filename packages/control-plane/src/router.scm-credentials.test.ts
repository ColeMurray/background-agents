import { describe, expect, it, vi } from "vitest";
import {
  fakeSessionRuntimeDispatch,
  handleRequest,
  matchRoute,
  routeContracts as routes,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";

function routeFor(method: string, path: string) {
  return matchRoute(routes, method, path)?.route;
}

function createEnv(options?: { actorAuthorized?: boolean }) {
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/internal/verify-sandbox-token") {
      const body = (await request.json()) as { token?: string };
      return new Response(null, { status: body.token === "sandbox-token" ? 204 : 401 });
    }
    return Response.json({ ok: true }, { status: 202 });
  });
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  const addressed = vi.fn((sessionId: string) => sessionId);
  return {
    fetch,
    addressed,
    statement,
    env: {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "gitlab",
      GITLAB_ACCESS_TOKEN: "glpat-test",
      DB: {
        prepare: vi.fn((sql: string) => {
          if (options?.actorAuthorized && sql.includes("FROM user_identities")) {
            const identityStatement = {
              bind: vi.fn(() => identityStatement),
              first: vi.fn(async () => ({
                id: "identity-linear-u1",
                user_id: "user-1",
                provider: "linear",
                provider_user_id: "U1",
                provider_login: null,
                provider_email: null,
                provider_issuer: null,
                created_at: 1,
              })),
            };
            return identityStatement;
          }
          if (
            options?.actorAuthorized &&
            sql.includes("FROM users u") &&
            sql.includes("user_role_assignments")
          ) {
            const authorizationStatement = {
              bind: vi.fn(() => authorizationStatement),
              first: vi.fn(async () => ({
                user_id: "user-1",
                suspended_at: null,
                role_id: "role_builtin_member",
                role_key: "member",
                role_name: "Member",
              })),
            };
            return authorizationStatement;
          }
          return statement;
        }),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: fakeSessionRuntimeDispatch((request, sessionId) => {
        addressed(sessionId);
        return fetch(request);
      }),
    },
  };
}

describe("SCM credentials router provider gate", () => {
  it.each(["openai-token-refresh", "xai-token-refresh"])(
    "rejects service authentication for the %s broker",
    async (endpoint) => {
      const { env } = createEnv();
      const response = await handleRequest(
        await signedServiceRequest(`https://test.local/sessions/session-1/${endpoint}`, {
          method: "POST",
        }),
        env as never,
        TEST_BACKGROUND_TASK_CONTEXT
      );

      expect(response.status).toBe(401);
    }
  );

  it("allows a matching sandbox token to reach the xAI broker", async () => {
    const { env, fetch, statement } = createEnv();
    statement.first.mockResolvedValue({
      provider: "xai",
      auth_mode: "legacy_scoped_oauth",
      provider_account_id: null,
      selection_source: "legacy_migration",
      inherited_from_session_id: null,
    } as never);
    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/xai-token-refresh", {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[1][0].url).pathname).toBe("/internal/xai-token-refresh");
  });

  it.each(["slack-bot", "github-bot", "linear-bot"] as const)(
    "rejects %s authentication before reaching the SCM credential broker",
    async (service) => {
      const { env, fetch } = createEnv();

      const response = await handleRequest(
        await signedServiceRequest("https://test.local/sessions/session-1/scm-credentials", {
          method: "POST",
          service,
        }),
        env as never,
        TEST_BACKGROUND_TASK_CONTEXT
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Unauthorized: Missing sandbox token",
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("allows a matching sandbox token to reach the GitLab SCM credential broker", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe("/internal/verify-sandbox-token");
    expect(new URL(fetch.mock.calls[1][0].url).pathname).toBe("/internal/scm-credentials");
  });

  it("requires an actor for service access to tunnel URLs", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/tunnel-urls", {
        service: "linear-bot",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats provider-neutral SCM settings routes as SCM-agnostic", () => {
    expect(routeFor("GET", "/scm-settings")?.supportedScmProviders).toBe("all");
    expect(routeFor("GET", "/scm-settings/repos")?.supportedScmProviders).toBe("all");
  });

  it("returns an explicit disabled signing state for GitLab sandboxes", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/commit-signing", {
        headers: { Authorization: "Bearer sandbox-token" },
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ enabled: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe("/internal/verify-sandbox-token");
  });

  it("rejects service authentication for the signing-key broker", async () => {
    const { env } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/commit-signing"),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
  });

  it("rejects service authentication for parent-to-child prompts", async () => {
    const { env } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/parent-1/children/child-1/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Continue" }),
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(401);
  });

  it("allows GitLab parent sandboxes to reach the child prompt route", async () => {
    const { env, fetch, addressed } = createEnv();

    const response = await handleRequest(
      new Request("https://test.local/sessions/parent-1/children/child-1/prompt", {
        method: "POST",
        headers: {
          Authorization: "Bearer sandbox-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Continue" }),
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    // The null DB lookup rejects the unknown child after sandbox auth and SCM classification.
    expect(response.status).toBe(404);
    expect(fetch).toHaveBeenCalledOnce();
    expect(addressed).toHaveBeenCalledWith("parent-1");
    expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe("/internal/verify-sandbox-token");
  });

  it("rejects actorless services before unrelated GitLab session routes", async () => {
    const { env, fetch } = createEnv();

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/pr", {
        method: "POST",
        service: "linear-bot",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the provider gate after authorizing an actor on a GitHub-only route", async () => {
    const { env, fetch } = createEnv({ actorAuthorized: true });

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/pr", {
        method: "POST",
        service: "linear-bot",
        actor: "linear:U1",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "SCM provider 'gitlab' is not implemented in this deployment.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows GitLab deployments to reach the SCM-independent read-state route", async () => {
    expect(routeFor("PATCH", "/sessions/session-1/read-state")?.supportedScmProviders).toBe("all");
  });

  it("allows GitLab deployments to read the canonical session resource", () => {
    expect(routeFor("GET", "/sessions/session-1")?.supportedScmProviders).toBe("all");
  });

  it("allows GitLab deployments to read sandbox access", () => {
    expect(routeFor("GET", "/sessions/session-1/sandbox-access")?.supportedScmProviders).toBe(
      "all"
    );
  });
});
