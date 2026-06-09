import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { generateInternalToken } from "./auth/internal";
import { SessionIndexStore } from "./db/session-index";
import { SessionInternalPaths } from "./session/contracts";

const integrationSettingsMocks = vi.hoisted(() => ({
  resolveCodeServerEnabled: vi.fn().mockResolvedValue(false),
  resolveSandboxSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./session/integration-settings-resolution", () => integrationSettingsMocks);

describe("handleSpawnChild prompt enqueue handling", () => {
  const parentId = "parent-session-1";

  const spawnContext = {
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    owner: {
      userId: "user-1",
      scmLogin: "acmedev",
      scmName: "Acme Dev",
      scmEmail: "dev@acme.test",
      scmAccessTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: null,
    },
  };

  const makeStore = (parentUserId: string | null = null) => ({
    get: vi.fn().mockResolvedValue({
      userId: parentUserId,
      repoOwner: spawnContext.repoOwner,
      repoName: spawnContext.repoName,
    }),
    getSpawnDepth: vi.fn().mockResolvedValue(0),
    countActiveChildren: vi.fn().mockResolvedValue(0),
    countTotalChildren: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    integrationSettingsMocks.resolveCodeServerEnabled.mockResolvedValue(false);
    integrationSettingsMocks.resolveSandboxSettings.mockResolvedValue({});
  });

  async function makeRequest(env: Record<string, unknown>): Promise<Response> {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET as string);

    return handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: "Child task", prompt: "Do the thing" }),
      }),
      env as never
    );
  }

  it("returns 201 when child prompt enqueue succeeds", async () => {
    const store = makeStore("canonical-user-123");
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
        if (path === SessionInternalPaths.prompt)
          return Response.json({ messageId: "msg-1", status: "queued" });
        return Response.json({ error: "unexpected" }, { status: 404 });
      }),
    } as never;

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
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
    expect(store.updateStatus).not.toHaveBeenCalled();
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
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

    const response = await handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "not-a-real-model",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model "not-a-real-model"');
    expect(payload.error).toContain("Valid models:");
  });

  it("uses configured concurrent child session limit", async () => {
    const store = makeStore();
    store.countActiveChildren.mockResolvedValue(2);
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
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
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
    expect(integrationSettingsMocks.resolveSandboxSettings).toHaveBeenCalledWith(
      expect.any(Object),
      "acme",
      "web-app"
    );
  });

  it("uses configured total child session limit", async () => {
    const store = makeStore();
    store.countActiveChildren.mockResolvedValue(0);
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
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
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
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
      SCM_PROVIDER: "github",
      DB: {},
      SESSION: {
        idFromName: (name: string) => name,
        get: () => parentStub,
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);

    const response = await handleRequest(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "Child task",
          prompt: "Do the thing",
          model: "",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(400);
    const payload = await response.json<{ error: string }>();
    expect(payload.error).toContain('Invalid model ""');
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
      INTERNAL_CALLBACK_SECRET: "test-internal-secret",
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
