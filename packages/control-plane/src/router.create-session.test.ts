import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { SessionIndexStore } from "./db/session-index";
import { handleRequest } from "./router";
import { resolveRepoOrError } from "./routes/shared";
import { SessionInternalPaths } from "./session/contracts";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
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
});
