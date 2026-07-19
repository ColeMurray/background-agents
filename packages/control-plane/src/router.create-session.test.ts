import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { SessionIndexStore } from "./db/session-index";
import { UserStore } from "./db/user-store";
import { handleRequest } from "./router";
import { sessionCreateRoutes } from "./routes/session-create";
import { HttpError, resolveRepoOrError } from "./routes/shared";
import { SessionInternalPaths } from "./session/contracts";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

vi.mock("./routes/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn(),
  };
});

describe("handleCreateSession D1 ordering", () => {
  const secret = "test-internal-secret";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      defaultBranch: "main",
    } as never);
  });

  async function createSessionRequestWithBody(
    env: Record<string, unknown>,
    body: Record<string, unknown>
  ): Promise<Response> {
    const token = await generateInternalToken(secret);

    return handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
      env as never
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
    const token = await generateInternalToken(secret);

    return handleRequest(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
      }),
      createEnv(vi.fn()) as never
    );
  }

  function createEnv(initFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };

    return {
      INTERNAL_CALLBACK_SECRET: secret,
      SCM_PROVIDER: "github",
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: initFetch }),
      },
    };
  }

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

  it("replaces caller author fields with the linked GitHub identity", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        resolveOrCreateUser: async () => ({ id: "user-1" }),
        getIdentitiesForUser: async () => [
          {
            provider: "github",
            providerUserId: "1001",
            providerLogin: "ada",
            providerEmail: "private@example.com",
          },
        ],
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
      } as never;
    });
    const initFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        scmUserId: "1001",
        scmLogin: "ada",
        scmName: "Trusted Ada",
        scmEmail: "1001+ada@users.noreply.github.com",
      });
      return Response.json({ status: "created" });
    });

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "Attributed session",
      model: "anthropic/claude-haiku-4-5",
      spawnSource: "user",
      scmUserId: "1001",
      scmLogin: "caller-login",
      scmName: "Caller Name",
      scmEmail: "caller@example.com",
    });

    expect(response.status).toBe(201);
    expect(initFetch).toHaveBeenCalledOnce();
  });

  it("does not retain caller GitHub attribution when D1 identity resolution fails", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        resolveOrCreateUser: async () => {
          throw new Error("D1 unavailable");
        },
      } as never;
    });
    const initFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.scmUserId).toBeUndefined();
      expect(body.scmLogin).toBeUndefined();
      expect(body.scmName).toBeUndefined();
      expect(body.scmEmail).toBeUndefined();
      return Response.json({ status: "created" });
    });

    const response = await createSessionRequestWithBody(createEnv(initFetch), {
      title: "Unresolved identity session",
      model: "anthropic/claude-haiku-4-5",
      spawnSource: "user",
      scmUserId: "1001",
      scmLogin: "caller-login",
      scmName: "Caller Name",
      scmEmail: "caller@example.com",
    });

    expect(response.status).toBe(201);
    expect(initFetch).toHaveBeenCalledOnce();
  });

  it("preserves non-GitHub SCM identity when the user also has a linked GitHub identity", async () => {
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
        resolveOrCreateUser: async () => ({ id: "user-1" }),
        getIdentitiesForUser,
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
      } as never;
    });
    const initFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        scmUserId: "gitlab-42",
        scmLogin: "gitlab-ada",
        scmName: "GitLab Ada",
        scmEmail: "ada@gitlab.example.com",
      });
      return Response.json({ status: "created" });
    });
    const testEnv: Record<string, unknown> = createEnv(initFetch);
    testEnv.SCM_PROVIDER = "gitlab";

    const response = await sessionCreateRoutes[0].handler(
      new Request("https://test.local/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner: "acme",
          repoName: "project",
          title: "GitLab session",
          model: "anthropic/claude-haiku-4-5",
          spawnSource: "user",
          scmUserId: "gitlab-42",
          scmLogin: "gitlab-ada",
          scmName: "GitLab Ada",
          scmEmail: "ada@gitlab.example.com",
        }),
      }),
      testEnv as never,
      [] as unknown as RegExpMatchArray,
      {
        request_id: "test-request",
        trace_id: "test-trace",
        db: testEnv["DB"] as never,
        metrics: {
          d1Queries: [],
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
