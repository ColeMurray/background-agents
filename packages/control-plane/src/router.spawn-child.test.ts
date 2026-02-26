import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { generateInternalToken } from "./auth/internal";
import { SessionIndexStore } from "./db/session-index";

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

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

  const makeStore = () => ({
    getSpawnDepth: vi.fn().mockResolvedValue(0),
    countActiveChildren: vi.fn().mockResolvedValue(0),
    countTotalChildren: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/internal/init") return Response.json({ status: "ok" });
        if (path === "/internal/prompt")
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

    const createdChildId = store.create.mock.calls[0]?.[0]?.id;
    expect(createdChildId).toBe(payload.sessionId);
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it("returns an error and marks child failed when prompt enqueue fails", async () => {
    const store = makeStore();
    vi.mocked(SessionIndexStore).mockImplementation(() => store as never);

    const parentStub: DurableObjectStub = {
      fetch: vi.fn(async () => Response.json(spawnContext)),
    } as never;

    const childStub: DurableObjectStub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/internal/init") return Response.json({ status: "ok" });
        if (path === "/internal/prompt") {
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
