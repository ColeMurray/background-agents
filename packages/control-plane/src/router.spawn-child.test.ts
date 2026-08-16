import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import {
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";
import { getEffectiveEnabledModels } from "./db/model-preferences";
import { SessionIndexStore } from "./db/session-index";
import { SessionInternalPaths } from "./session/contracts";

const integrationSettingsMocks = vi.hoisted(() => ({
  resolveCodeServerEnabled: vi.fn().mockResolvedValue(false),
  resolveVncEnabled: vi.fn().mockResolvedValue(false),
  resolveSandboxSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./db/model-preferences", () => ({
  getEffectiveEnabledModels: vi.fn(),
}));

vi.mock("./session/integration-settings-resolution", () => integrationSettingsMocks);

describe("handleSpawnChild prompt enqueue handling", () => {
  const parentId = "parent-session-1";

  type TestSpawnContext = {
    repoOwner: string | null;
    repoName: string | null;
    repoId: number | null;
    baseBranch?: string | null;
    model: string;
    reasoningEffort: string | null;
    sandboxTimeoutMs?: number;
    promptAuthor: {
      userId: string;
      canonicalUserId?: string | null;
      scmUserId: string | null;
      scmLogin: string | null;
      scmName: string | null;
      scmEmail: string | null;
      scmAccessTokenEncrypted: string | null;
      scmRefreshTokenEncrypted: string | null;
      scmTokenExpiresAt: number | null;
    };
  };

  const spawnContext: TestSpawnContext = {
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    sandboxTimeoutMs: 14_400_000,
    baseBranch: "main",
    promptAuthor: {
      userId: "user-1",
      canonicalUserId: "canonical-user-123",
      scmUserId: "12345",
      scmLogin: "acmedev",
      scmName: "Acme Dev",
      scmEmail: "dev@acme.test",
      scmAccessTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: null,
    },
  };

  const makeStore = (
    parentUserId: string | null = null,
    context: typeof spawnContext = spawnContext
  ) => ({
    get: vi.fn().mockResolvedValue({
      userId: parentUserId,
      repoOwner: context.repoOwner,
      repoName: context.repoName,
      environmentId: "env_parent",
    }),
    getSpawnDepth: vi.fn().mockResolvedValue(0),
    countTotalChildren: vi.fn().mockResolvedValue(0),
    acquireChildAdmissionLease: vi.fn().mockResolvedValue({
      token: "lease-token",
      childSessionId: "child-session",
      expiresAt: Date.now() + 60_000,
    }),
    releaseChildAdmissionLease: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEffectiveEnabledModels).mockResolvedValue(["anthropic/claude-sonnet-4-6"]);
    integrationSettingsMocks.resolveCodeServerEnabled.mockResolvedValue(false);
    integrationSettingsMocks.resolveVncEnabled.mockResolvedValue(false);
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({});
  });

  async function makeRequest(
    env: Record<string, unknown>,
    body: Record<string, unknown> = { title: "Child task", prompt: "Do the thing" }
  ): Promise<Response> {
    return handleRequest(
      await signedServiceRequest(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        body: JSON.stringify(body),
        service: "linear-bot",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  function makeSuccessfulEnv(context: TestSpawnContext) {
    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(context)),
    } as never;
    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) return Response.json({ status: "ok" });
        if (path === SessionInternalPaths.prompt) {
          return Response.json({ messageId: "msg-1", status: "queued" });
        }
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;
    return {
      childStub,
      env: {
        ...TEST_SERVICE_SECRETS,
        SCM_PROVIDER: "github",
        DB: {},
        SESSION: {
          idFromName: (name: string) => name,
          get: (id: string) => (id === parentId ? parentStub : childStub),
        },
      },
    };
  }

  async function getInitBody(childStub: DurableObjectStub) {
    const initRequest = vi.mocked(childStub.fetch).mock.calls.find((call) => {
      const request = call[0] as Request;
      return new URL(request.url).pathname === SessionInternalPaths.init;
    })?.[0] as Request;
    return initRequest.json<{ reasoningEffort: string | null }>();
  }

  it("inherits the parent's reasoning effort when omitted", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    const { env, childStub } = makeSuccessfulEnv({ ...spawnContext, reasoningEffort: "high" });

    const response = await makeRequest(env);

    expect(response.status).toBe(201);
    await expect(getInitBody(childStub)).resolves.toMatchObject({ reasoningEffort: "high" });
  });

  it("uses an explicit child reasoning effort override", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    const { env, childStub } = makeSuccessfulEnv({ ...spawnContext, reasoningEffort: "high" });

    const response = await makeRequest(env, {
      title: "Child task",
      prompt: "Do the thing",
      reasoningEffort: "low",
    });

    expect(response.status).toBe(201);
    await expect(getInitBody(childStub)).resolves.toMatchObject({ reasoningEffort: "low" });
  });

  it("rejects an explicit reasoning effort incompatible with the resolved model", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    const { env, childStub } = makeSuccessfulEnv({ ...spawnContext, reasoningEffort: "high" });

    const response = await makeRequest(env, {
      title: "Child task",
      prompt: "Do the thing",
      reasoningEffort: "xhigh",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Invalid reasoning effort "xhigh" for model "anthropic/claude-sonnet-4-6". Valid efforts: low, medium, high, max',
    });
    expect(childStub.fetch).not.toHaveBeenCalled();
  });

  it('rejects "x-high" and reports the canonical "xhigh" value', async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    vi.mocked(getEffectiveEnabledModels).mockResolvedValue([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.6-sol",
    ]);
    const { env, childStub } = makeSuccessfulEnv(spawnContext);

    const response = await makeRequest(env, {
      title: "Child task",
      prompt: "Do the thing",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "x-high",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Invalid reasoning effort "x-high" for model "openai/gpt-5.6-sol". Valid efforts: none, low, medium, high, xhigh',
    });
    expect(childStub.fetch).not.toHaveBeenCalled();
  });

  it('accepts canonical "xhigh" for a model that supports it', async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    vi.mocked(getEffectiveEnabledModels).mockResolvedValue([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.6-sol",
    ]);
    const { env, childStub } = makeSuccessfulEnv(spawnContext);

    const response = await makeRequest(env, {
      title: "Child task",
      prompt: "Do the thing",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    expect(response.status).toBe(201);
    await expect(getInitBody(childStub)).resolves.toMatchObject({ reasoningEffort: "xhigh" });
  });

  it("returns 201 when child prompt enqueue succeeds", async () => {
    const store = makeStore("canonical-user-123");
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({
      sandboxTimeoutMs: 3_600_000,
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) return Response.json({ status: "ok" });
        if (path === SessionInternalPaths.prompt)
          return Response.json({ messageId: "msg-1", status: "queued" });
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === parentId ? parentStub : childStub),
      },
    };

    const response = await makeRequest(env);
    expect(response.status).toBe(201);

    const payload = await response.json<{ sessionId: string; status: string }>();
    expect(payload.status).toBe("created");

    const childEntry = store.create.mock.calls[0]?.[0];
    expect(childEntry?.id).toBe(payload.sessionId);
    expect(childEntry?.userId).toBe("canonical-user-123");
    expect(childEntry?.environmentId).toBe("env_parent");

    const initRequest = vi.mocked(childStub.fetch).mock.calls.find((call) => {
      const request = call[0] as Request;
      return new URL(request.url).pathname === SessionInternalPaths.init;
    })?.[0] as Request | undefined;
    expect(initRequest).toBeDefined();
    await expect(initRequest!.json()).resolves.toMatchObject({
      environmentId: "env_parent",
      sandboxSettings: { sandboxTimeoutMs: 14_400_000 },
    });
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it("attributes the child and initial prompt to the active prompt author", async () => {
    const activeAuthorContext = {
      ...spawnContext,
      promptAuthor: {
        ...spawnContext.promptAuthor,
        userId: "slack:U2",
        canonicalUserId: "canonical-user-2",
        scmLogin: "second-user",
        scmAccessTokenEncrypted: "second-access",
      },
    };
    const store = makeStore("canonical-user-1", activeAuthorContext as never);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    const { env, childStub } = makeSuccessfulEnv(activeAuthorContext as never);

    const response = await makeRequest(env);

    expect(response.status).toBe(201);
    expect(store.create.mock.calls[0]?.[0]?.userId).toBe("canonical-user-2");
    await expect(getInitBody(childStub)).resolves.toMatchObject({
      userId: "slack:U2",
      canonicalUserId: "canonical-user-2",
      scmLogin: "second-user",
      scmTokenEncrypted: "second-access",
    });
    const promptRequest = vi.mocked(childStub.fetch).mock.calls.find((call) => {
      const request = call[0] as Request;
      return new URL(request.url).pathname === SessionInternalPaths.prompt;
    })?.[0] as Request;
    await expect(promptRequest.json()).resolves.toMatchObject({
      authorId: "slack:U2",
      canonicalUserId: "canonical-user-2",
      source: "agent",
    });
  });

  it("preserves the provider default when the parent has no snapshotted timeout", async () => {
    const store = makeStore("canonical-user-123");
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({
      sandboxTimeoutMs: 3_600_000,
      tunnelPorts: [3000],
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json({ ...spawnContext, sandboxTimeoutMs: undefined })),
    } as never;
    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) return Response.json({ status: "ok" });
        if (path === SessionInternalPaths.prompt) {
          return Response.json({ messageId: "msg-1", status: "queued" });
        }
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;
    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === parentId ? parentStub : childStub),
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(201);
    const initRequest = vi.mocked(childStub.fetch).mock.calls.find((call) => {
      const request = call[0] as Request;
      return new URL(request.url).pathname === SessionInternalPaths.init;
    })?.[0] as Request;
    const initBody = await initRequest.json<{ sandboxSettings: Record<string, unknown> }>();
    expect(initBody.sandboxSettings).toEqual({ tunnelPorts: [3000] });
  });

  it("creates repo-less children for repo-less parents", async () => {
    const repoLessContext = {
      ...spawnContext,
      repoOwner: null,
      repoName: null,
      repoId: null,
      baseBranch: null,
    };
    const store = makeStore("canonical-user-123", repoLessContext);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(repoLessContext)),
    } as never;

    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) return Response.json({ status: "ok" });
        if (path === SessionInternalPaths.prompt)
          return Response.json({ messageId: "msg-1", status: "queued" });
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === parentId ? parentStub : childStub),
      },
    };

    const response = await makeRequest(env);
    expect(response.status).toBe(201);

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: null,
        repoName: null,
        baseBranch: null,
      })
    );
  });

  it("returns 400 when child specifies an invalid model", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await handleRequest(
      await signedServiceRequest(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        service: "linear-bot",
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "not-a-real-model",
        }),
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model "not-a-real-model"');
    expect(payload.error).toContain("Valid models:");
  });

  it("returns 503 when enabled model preferences cannot be read", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    vi.mocked(getEffectiveEnabledModels).mockRejectedValue(new Error("D1 unavailable"));

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;
    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Model preferences unavailable" });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed child spawn request", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: vi.fn(),
      },
    };

    const response = await handleRequest(
      await signedServiceRequest(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        service: "linear-bot",
        body: JSON.stringify({ title: "Child task" }),
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "title and prompt are required" });
    expect(SessionIndexStore).not.toHaveBeenCalled();
  });

  it("returns 500 for a malformed parent spawn context", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json({ repoOwner: "acme", repoName: "web-app" })),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to get parent session context",
    });
  });

  it("uses configured concurrent child session limit", async () => {
    const store = makeStore();
    store.acquireChildAdmissionLease.mockResolvedValue(null);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({
      maxConcurrentChildSessions: 2,
      maxTotalChildSessions: 15,
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "Maximum concurrent children (2) reached",
    });
    // Children resolve limits from the parent's settings scope, including its
    // environment override layer (design §13.5).
    expect(integrationSettingsMocks.resolveSandboxSettings).toHaveBeenCalledWith(
      expect.any(Object),
      "acme",
      "web-app",
      "env_parent"
    );
  });

  it("uses configured total child session limit", async () => {
    const store = makeStore();
    store.countTotalChildren.mockResolvedValue(4);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({
      maxConcurrentChildSessions: 5,
      maxTotalChildSessions: 4,
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: "Maximum total children (4) reached",
    });
  });

  it("returns 400 when child specifies an empty-string model", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await handleRequest(
      await signedServiceRequest(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        service: "linear-bot",
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "",
        }),
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model ""');
  });

  it("propagates parent spawn-context errors", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () =>
        Response.json({ error: "Child sessions require a repository context" }, { status: 400 })
      ),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const response = await makeRequest(env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Child sessions require a repository context",
    });
    expect(store.create).not.toHaveBeenCalled();
  });

  it("returns an error and marks child failed when prompt enqueue fails", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return store as never;
    });

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === SessionInternalPaths.init) return Response.json({ status: "ok" });
        if (path === SessionInternalPaths.prompt) {
          return Response.json({ error: "enqueue failed" }, { status: 503 });
        }
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;

    const env = {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: (id: string) => (id === parentId ? parentStub : childStub),
      },
    };

    const response = await makeRequest(env);
    expect(response.status).toBe(500);

    const payload = await response.json<{ error: string }>();
    expect(payload.error).toBe("Failed to enqueue child session prompt");

    const createdChildId = store.create.mock.calls[0]?.[0]?.id;
    expect(store.updateStatus).toHaveBeenCalledWith(createdChildId, "failed");
  });
});
