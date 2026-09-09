import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "./auth/crypto";
import { SessionIndexStore } from "./db/session-index";
import { UserStore } from "./db/user-store";
import {
  fakeSessionRuntimeDispatch,
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";
import { handleCreateSession } from "./routes/session-create";
import { HttpError, resolveRepoOrError } from "./routes/shared";
import { SessionInternalPaths } from "./session/contracts";
import { resolveManagedSkills } from "./session/skill-resolution";
import { resolveSessionProviderAuth } from "./session/provider-account-resolution";
import { ProviderAccountSelectionPolicyError } from "./model-provider-accounts/selection-policy";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "./repos/resolve";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

vi.mock("./session/skill-resolution", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveManagedSkills: vi.fn(),
  };
});

vi.mock("./session/provider-account-resolution", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveSessionProviderAuth: vi.fn() };
});

vi.mock("./routes/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn(),
  };
});

vi.mock("./repos/resolve", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEnvironmentTarget: vi.fn(),
    resolveSessionRepositories: vi.fn(),
  };
});

describe("handleCreateSession D1 ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveManagedSkills).mockResolvedValue({
      selection: { mode: "all" },
      resolverVersion: 1,
      manifestSha256: "0".repeat(64),
      resolvedAt: 1,
      skills: [],
    });
    vi.mocked(resolveSessionProviderAuth).mockResolvedValue([
      { provider: "openai", authMode: "api_key", selectionSource: "fallback_api_key" },
      { provider: "xai", authMode: "api_key", selectionSource: "fallback_api_key" },
    ]);
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      defaultBranch: "main",
    } as never);
    vi.mocked(resolveEnvironmentTarget).mockResolvedValue([
      { repoOwner: "acme", repoName: "environment-repo", baseBranch: "main" },
    ]);
    vi.mocked(resolveSessionRepositories).mockImplementation(async (_env, repositories) =>
      repositories.map((repository, index) => ({
        ...repository,
        repoId: 12345 + index,
        baseBranch: repository.baseBranch ?? "main",
      }))
    );
    // Default identity fixture: the slack-bot's asserted actor resolves to an
    // already-known canonical user with no linked GitHub identity.
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => ({ userId: "user-1" }),
        getIdentitiesForUser: async () => [],
      } as never;
    });
  });

  // Session creation requires a user identity, so router-level tests
  // authenticate as the slack-bot asserting a verified actor — the principal
  // (never the body) is what identity derives from.
  async function createSessionRequestWithBody(
    env: Record<string, unknown>,
    body: Record<string, unknown>
  ): Promise<Response> {
    return handleRequest(
      await signedServiceRequest("https://test.local/sessions", {
        method: "POST",
        body: JSON.stringify(body),
        service: "slack-bot",
        actor: "slack:U0123",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  async function createSessionRequest(env: Record<string, unknown>): Promise<Response> {
    return createSessionRequestWithBody(env, {
      repoOwner: "Acme",
      repoName: "Web-App",
      title: "Test session",
      model: "anthropic/claude-haiku-4-5",
    });
  }

  async function invalidCreateSessionRequest(body: string): Promise<Response> {
    return handleRequest(
      await signedServiceRequest("https://test.local/sessions", {
        method: "POST",
        body,
        service: "slack-bot",
        actor: "slack:U0123",
      }),
      createEnv(vi.fn()) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  function createEnv(
    initFetch: (request: Request) => Promise<Response>,
    permissions = ["sessions.create", "repositories.use", "environments.use"]
  ): Record<string, unknown> {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };

    return {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      // GitHub-identity enrichment reads the token store unconditionally, so
      // the env must carry valid key material (the db stub answers "no rows").
      TOKEN_ENCRYPTION_KEY: generateEncryptionKey(),
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("FROM users u") && sql.includes("user_role_assignments")) {
            let authorizedUserId = "user-1";
            const authorizationStatement = {
              bind: vi.fn((userId: string) => {
                authorizedUserId = userId;
                return authorizationStatement;
              }),
              first: vi.fn(async () => ({
                user_id: authorizedUserId,
                suspended_at: null,
                role_id: "role-1",
                role_key: null,
                role_name: "Test Role",
              })),
              all: vi.fn(async () => ({ results: [] })),
            };
            return authorizationStatement;
          }
          if (sql.includes("FROM role_permissions")) {
            const permissionStatement = {
              bind: vi.fn(() => permissionStatement),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({
                results: permissions.map((permission_id) => ({ permission_id })),
              })),
            };
            return permissionStatement;
          }
          if (sql.includes("suspended_at IS NULL")) {
            const activeStatement = {
              bind: vi.fn(() => activeStatement),
              first: vi.fn(async () => ({ active: 1 })),
              all: vi.fn(async () => ({ results: [] })),
              run: vi.fn(async () => ({ meta: { changes: 0 } })),
            };
            return activeStatement;
          }
          return statement;
        }),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: fakeSessionRuntimeDispatch(initFetch),
    };
  }

  it.each([
    {
      target: "environment",
      body: { environmentId: "env_1" },
      permissions: ["sessions.create", "environments.use"],
      status: 201,
      deniedPermission: null,
    },
    {
      target: "environment",
      body: { environmentId: "env_1" },
      permissions: ["sessions.create", "repositories.use"],
      status: 403,
      deniedPermission: "environments.use",
    },
    {
      target: "scalar repository",
      body: { repoOwner: "acme", repoName: "widgets" },
      permissions: ["sessions.create", "repositories.use"],
      status: 201,
      deniedPermission: null,
    },
    {
      target: "scalar repository",
      body: { repoOwner: "acme", repoName: "widgets" },
      permissions: ["sessions.create", "environments.use"],
      status: 403,
      deniedPermission: "repositories.use",
    },
    {
      target: "repository list",
      body: { repositories: [{ repoOwner: "acme", repoName: "widgets" }] },
      permissions: ["sessions.create", "repositories.use"],
      status: 201,
      deniedPermission: null,
    },
    {
      target: "repository list",
      body: { repositories: [{ repoOwner: "acme", repoName: "widgets" }] },
      permissions: ["sessions.create", "environments.use"],
      status: 403,
      deniedPermission: "repositories.use",
    },
  ])(
    "enforces the permission matrix for $target targets",
    async ({ body, permissions, status, deniedPermission }) => {
      const create = vi.fn().mockResolvedValue(undefined);
      vi.mocked(SessionIndexStore).mockImplementation(function () {
        return { create } as never;
      });
      const initFetch = vi.fn(async () => Response.json({ status: "created" }));

      const response = await createSessionRequestWithBody(createEnv(initFetch, permissions), {
        ...body,
        title: "Permission matrix",
      });

      expect(response.status).toBe(status);
      if (deniedPermission) {
        await expect(response.json()).resolves.toMatchObject({
          code: "permission_required",
          permission: deniedPermission,
        });
        expect(create).not.toHaveBeenCalled();
      } else {
        expect(create).toHaveBeenCalledOnce();
      }
    }
  );

  it("does not initialize the SessionDO when D1 session index creation fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("D1 unavailable"));
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });

    const initFetch = vi.fn(async () => Response.json({ status: "created" }));
    const response = await createSessionRequest(createEnv(initFetch));

    expect(response.status).toBe(500);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-trace-id")).toBeTruthy();
    expect(create).toHaveBeenCalledOnce();
    expect(initFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed create-session JSON before resolving the repo", async () => {
    const response = await invalidCreateSessionRequest("{");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("rejects non-object create-session JSON before resolving the repo", async () => {
    const response = await invalidCreateSessionRequest("null");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "JSON body must be an object" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("rejects forbidden identity fields from verified callers before resolving the repo", async () => {
    const initFetch = vi.fn(async () => Response.json({ status: "created" }));

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      repoOwner: "Acme",
      repoName: "Web-App",
      title: "Test session",
      model: "anthropic/claude-haiku-4-5",
      scmToken: "gho_attacker",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'scmToken' is not accepted from verified callers",
    });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
    expect(initFetch).not.toHaveBeenCalled();
  });

  it("creates a repo-less public session without resolving the repo", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    const initFetch = vi.fn(async () => Response.json({ status: "created" }));

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "No repo",
      model: "anthropic/claude-haiku-4-5",
    });

    expect(response.status).toBe(201);
    expect(resolveRepoOrError).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: null,
        repoName: null,
        baseBranch: null,
        userId: "user-1",
        spawnSource: "slack-bot",
      })
    );
    expect(initFetch).toHaveBeenCalledOnce();
  });

  it("rejects whitespace-only repository fields as invalid before resolving the repo", async () => {
    const response = await invalidCreateSessionRequest(
      JSON.stringify({
        repoOwner: "   ",
        repoName: "\t",
        title: "No repo",
        model: "anthropic/claude-haiku-4-5",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid session request body" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("rejects partial repository payloads as invalid before resolving the repo", async () => {
    const response = await invalidCreateSessionRequest(
      JSON.stringify({
        repoOwner: "Acme",
        title: "Partial repo",
        model: "anthropic/claude-haiku-4-5",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid session request body" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("rejects one-sided blank repository payloads as invalid before resolving the repo", async () => {
    const response = await invalidCreateSessionRequest(
      JSON.stringify({
        repoOwner: "Acme",
        repoName: " ",
        title: "Partial repo",
        model: "anthropic/claude-haiku-4-5",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid session request body" });
    expect(resolveRepoOrError).not.toHaveBeenCalled();
  });

  it("maps route HttpError failures through the central dispatch catch", async () => {
    vi.mocked(resolveRepoOrError).mockRejectedValue(
      new HttpError("Repository is not installed for the GitHub App", 404)
    );

    const initFetch = vi.fn(async () => Response.json({ status: "created" }));
    const response = await createSessionRequest(createEnv(initFetch));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Repository is not installed for the GitHub App",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-trace-id")).toBeTruthy();
    expect(initFetch).not.toHaveBeenCalled();
  });

  it("creates the D1 session index before initializing the SessionDO", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });

    const initFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(SessionInternalPaths.init);
      return Response.json({ status: "created" });
    });

    const response = await createSessionRequest(createEnv(initFetch));

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    expect(initFetch).toHaveBeenCalledOnce();
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(initFetch.mock.invocationCallOrder[0]);
  });

  it("resolves explicit provider selections for a user-created session", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    const initFetch = vi.fn(async () => Response.json({ status: "created" }));
    const explicit = {
      openai: { mode: "provider_account" as const, accountId: "1".repeat(32) },
    };

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "Explicit provider",
      providerSelections: explicit,
    });

    expect(response.status).toBe(201);
    expect(resolveSessionProviderAuth).toHaveBeenCalledWith(expect.anything(), {
      explicit,
      unattended: true,
    });
  });

  it.each([400, 404, 409] as const)(
    "preserves provider account policy status %i",
    async (status) => {
      vi.mocked(resolveSessionProviderAuth).mockRejectedValueOnce(
        new ProviderAccountSelectionPolicyError("Provider account rejected", status)
      );
      const create = vi.fn();
      vi.mocked(SessionIndexStore).mockImplementation(function () {
        return { create } as never;
      });

      const response = await createSessionRequestWithBody(createEnv(vi.fn()), {
        title: "Rejected provider",
        providerSelections: {
          openai: { mode: "provider_account", accountId: "1".repeat(32) },
        },
      });

      expect(response.status).toBe(status);
      expect(create).not.toHaveBeenCalled();
    }
  );

  it("enriches SCM fields from the resolved user's linked GitHub identity", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => ({ userId: "user-1" }),
        getIdentitiesForUser: async () => [
          {
            provider: "github",
            providerUserId: "2002",
            providerLogin: "ada",
            providerEmail: "private@example.com",
          },
        ],
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
      } as never;
    });
    const initFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      // Body display fields win; enrichment fills the gaps from the linked
      // GitHub identity. Credentials would come only from the token store
      // (none stored here), never from the body.
      expect(body).toMatchObject({
        userId: "slack:U0123",
        spawnSource: "slack-bot",
        scmUserId: "2002",
        scmLogin: "caller-login",
        scmName: "Trusted Ada",
        scmEmail: "2002+ada@users.noreply.github.com",
        scmTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
      });
      return Response.json({ status: "created" });
    });

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "Attributed session",
      model: "anthropic/claude-haiku-4-5",
      scmLogin: "caller-login",
    });

    expect(response.status).toBe(201);
    expect(initFetch).toHaveBeenCalledOnce();
  });

  it("resolves an unseen verified actor into a canonical user from display fields", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    const resolveOrCreateUser = vi.fn(async () => ({ id: "user-1" }));
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => null,
        resolveOrCreateUser,
        getIdentitiesForUser: async () => [],
      } as never;
    });
    const initFetch = vi.fn(async () => Response.json({ status: "created" }));

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "First-contact session",
      model: "anthropic/claude-haiku-4-5",
      actorDisplayName: "Ada Lovelace",
      actorEmail: "ada@example.com",
      actorAvatarUrl: "https://avatars.example.com/ada.png",
    });

    expect(response.status).toBe(201);
    expect(resolveOrCreateUser).toHaveBeenCalledWith({
      provider: "slack",
      providerUserId: "U0123",
      displayName: "Ada Lovelace",
      providerEmail: "ada@example.com",
      avatarUrl: "https://avatars.example.com/ada.png",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(initFetch).toHaveBeenCalledOnce();
  });

  it("fails closed without creating the session when actor resolution is unavailable", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => null,
        resolveOrCreateUser: async () => {
          throw new Error("D1 unavailable");
        },
      } as never;
    });
    const initFetch = vi.fn(async () => Response.json({ status: "created" }));

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "Unresolved identity session",
      model: "anthropic/claude-haiku-4-5",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Authorization unavailable",
      code: "authorization_unavailable",
    });
    expect(create).not.toHaveBeenCalled();
    expect(initFetch).not.toHaveBeenCalled();
  });

  it("preserves non-GitHub SCM display identity without GitHub enrichment", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    const getIdentitiesForUser = vi.fn(async () => [
      {
        provider: "github",
        providerUserId: "1001",
        providerLogin: "ada",
        providerEmail: "private@example.com",
      },
    ]);
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentitiesForUser,
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
      } as never;
    });
    const initFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        scmLogin: "gitlab-ada",
        scmName: "GitLab Ada",
        scmEmail: "ada@gitlab.example.com",
      });
      expect(body.scmUserId).toBeUndefined();
      return Response.json({ status: "created" });
    });
    const testEnv: Record<string, unknown> = createEnv(initFetch);
    testEnv.SCM_PROVIDER = "gitlab";

    const response = await handleCreateSession(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner: "acme",
          repoName: "project",
          title: "GitLab session",
          model: "anthropic/claude-haiku-4-5",
          scmLogin: "gitlab-ada",
          scmName: "GitLab Ada",
          scmEmail: "ada@gitlab.example.com",
        }),
      }),
      testEnv as never,
      {},
      {
        request_id: "test-request",
        trace_id: "test-trace",
        principal: {
          kind: "service",
          service: "linear-bot",
          actor: {
            provider: "linear",
            providerUserId: "linear-user-1",
            canonicalUserId: "user-1",
            participantUserId: "linear:linear-user-1",
          },
        },
        authorization: {
          userId: "user-1",
          suspendedAt: null,
          role: { id: "role-1", key: "member", name: "Member" },
          permissions: ["sessions.create", "repositories.use", "environments.use"],
        },
        db: testEnv["DB"] as never,
        executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
        metrics: {
          sqlQueries: [],
          spans: {},
          time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
          summarize: () => ({}),
        },
      }
    );

    expect(response.status).toBe(201);
    expect(initFetch).toHaveBeenCalledOnce();
    expect(getIdentitiesForUser).not.toHaveBeenCalled();
  });
});
