import { describe, expect, it, vi, beforeEach } from "vitest";
import app from "./index";
import type { Env, Activity } from "./types";

vi.mock("./utils/jwt-validator", () => ({
  validateBotFrameworkToken: vi.fn().mockResolvedValue(true),
}));

vi.mock("./utils/teams-client", () => ({
  sendReply: vi.fn().mockResolvedValue(undefined),
  sendTypingIndicator: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./classifier", () => ({
  createClassifier: vi.fn().mockReturnValue({
    classify: vi.fn().mockResolvedValue({
      repo: {
        id: "octocat/repo",
        owner: "octocat",
        name: "repo",
        fullName: "octocat/repo",
        displayName: "repo",
        description: "A test repo",
        defaultBranch: "main",
        private: false,
      },
      confidence: "high",
      reasoning: "Only repo available",
      needsClarification: false,
    }),
  }),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn().mockResolvedValue([
    {
      id: "octocat/repo",
      owner: "octocat",
      name: "repo",
      fullName: "octocat/repo",
      displayName: "repo",
      description: "A test repo",
      defaultBranch: "main",
      private: false,
    },
  ]),
}));

const mockSendReply = vi.mocked((await import("./utils/teams-client")).sendReply);

function createMockEnv(): Env {
  return {
    TEAMS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    CONTROL_PLANE: {
      fetch: vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("/sessions") && !url.includes("/events") && !url.includes("/prompt")) {
          return new Response(JSON.stringify({ sessionId: "session-123", status: "active" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/prompt")) {
          return new Response(JSON.stringify({ messageId: "msg-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/integration-settings")) {
          return new Response(
            JSON.stringify({ config: { model: null, reasoningEffort: null, typingMode: null } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/model-preferences")) {
          return new Response(JSON.stringify({ enabledModels: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    },
    MICROSOFT_APP_ID: "test-app-id",
    MICROSOFT_APP_PASSWORD: "test-password",
    MICROSOFT_TENANT_ID: "test-tenant",
    INTERNAL_CALLBACK_SECRET: "test-secret",
    WEB_APP_URL: "https://app.example.com",
    DEFAULT_MODEL: "claude-sonnet-4-6",
    CLASSIFICATION_MODEL: "claude-haiku-4-5",
    ANTHROPIC_API_KEY: "test-key",
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.example.com",
  } as unknown as Env;
}

function createActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: "message",
    id: "activity-1",
    timestamp: new Date().toISOString(),
    serviceUrl: "https://smba.trafficmanager.net/teams/",
    channelId: "msteams",
    from: { id: "user-1", name: "Test User", aadObjectId: "aad-1" },
    conversation: { id: "conv-1", conversationType: "channel" },
    recipient: { id: "bot-1", name: "Bot" },
    text: "<at>Bot</at> fix the bug",
    entities: [{ type: "mention", mentioned: { id: "bot-1", name: "Bot" }, text: "<at>Bot</at>" }],
    ...overrides,
  };
}

/** Create a mock ExecutionContext for Hono's app.request() */
function createExecutionCtx(): ExecutionContext {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: () => {},
  } as ExecutionContext;
}

/** Helper to make a request with execution context */
async function appRequest(path: string, init: RequestInit, env: Env): Promise<Response> {
  return app.request(path, init, env, createExecutionCtx());
}

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const env = createMockEnv();
    const res = await app.request("/health", { method: "GET" }, env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("open-inspect-teams-bot");
  });
});

describe("POST /api/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when JWT validation fails", async () => {
    const { validateBotFrameworkToken } = await import("./utils/jwt-validator");
    vi.mocked(validateBotFrameworkToken).mockResolvedValueOnce(false);

    const env = createMockEnv();
    const res = await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: JSON.stringify(createActivity()),
      },
      env
    );

    expect(res.status).toBe(401);
  });

  it("returns 200 for valid message activity", async () => {
    const env = createMockEnv();
    const res = await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid-token",
        },
        body: JSON.stringify(createActivity()),
      },
      env
    );

    expect(res.status).toBe(200);
  });

  it("deduplicates activities by ID", async () => {
    const env = createMockEnv();
    const activity = createActivity();
    const dedupeKey = `activity:${activity.id}`;

    // First request: dedup key not found (null), message is processed
    // Second request: dedup key exists ("1"), message is skipped
    const kvGet = vi.fn().mockImplementation(async (key: string) => {
      if (key === dedupeKey) {
        // Return null on first call, "1" on subsequent calls
        const calls = kvGet.mock.calls.filter((c: string[]) => c[0] === dedupeKey);
        return calls.length <= 1 ? null : "1";
      }
      return null;
    });
    (env.TEAMS_KV as unknown as Record<string, unknown>).get = kvGet;

    await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
        body: JSON.stringify(activity),
      },
      env
    );

    const res2 = await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
        body: JSON.stringify(activity),
      },
      env
    );

    expect(res2.status).toBe(200);
    // Both requests should check the dedup key
    const dedupeChecks = kvGet.mock.calls.filter((c: string[]) => c[0] === dedupeKey);
    expect(dedupeChecks.length).toBeGreaterThanOrEqual(2);
  });

  it("handles reset command", async () => {
    const env = createMockEnv();
    const activity = createActivity({
      text: "reset",
      entities: [],
      conversation: { id: "conv-1", conversationType: "personal" },
    });

    await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
        body: JSON.stringify(activity),
      },
      env
    );

    // waitUntil is fire-and-forget, give async handlers time to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(env.TEAMS_KV.delete).toHaveBeenCalled();
    expect(mockSendReply).toHaveBeenCalledWith(
      expect.any(String),
      "conv-1",
      expect.any(String),
      "test-app-id",
      "test-password",
      "test-tenant",
      "Session cleared. Send a new message to start a fresh session."
    );
  });

  it("handles settings command", async () => {
    const env = createMockEnv();
    const activity = createActivity({
      text: "settings",
      entities: [],
      conversation: { id: "conv-1", conversationType: "personal" },
    });

    await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
        body: JSON.stringify(activity),
      },
      env
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    // Settings command should send a reply with an adaptive card
    expect(mockSendReply).toHaveBeenCalledWith(
      expect.any(String),
      "conv-1",
      expect.any(String),
      "test-app-id",
      "test-password",
      "test-tenant",
      "Open-Inspect Settings",
      expect.arrayContaining([
        expect.objectContaining({ contentType: "application/vnd.microsoft.card.adaptive" }),
      ])
    );
  });

  it("silently ignores empty text from card submission echoes", async () => {
    const env = createMockEnv();
    const activity = createActivity({
      text: "",
      entities: [],
    });

    const res = await appRequest(
      "/api/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer token" },
        body: JSON.stringify(activity),
      },
      env
    );

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Should not send any reply for empty text
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});
