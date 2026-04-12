import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
import type * as SlackClientModule from "./utils/slack-client";

const DEFAULT_REPO = {
  id: "acme/app",
  owner: "acme",
  name: "app",
  fullName: "acme/app",
  displayName: "app",
  description: "Primary application repository",
  defaultBranch: "main",
  private: true,
};

const SECOND_REPO = {
  id: "acme/api",
  owner: "acme",
  name: "api",
  fullName: "acme/api",
  displayName: "api",
  description: "API service repository",
  defaultBranch: "main",
  private: true,
};

const {
  mockVerifySlackSignature,
  mockGetChannelInfo,
  mockGetThreadMessages,
  mockGetMessageByTimestamp,
  mockPostMessage,
  mockUpdateMessage,
  mockAddReaction,
  mockGetUserInfo,
  mockPublishView,
  mockOpenView,
} = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockGetChannelInfo: vi.fn(),
  mockGetThreadMessages: vi.fn(),
  mockGetMessageByTimestamp: vi.fn(),
  mockPostMessage: vi.fn(),
  mockUpdateMessage: vi.fn(),
  mockAddReaction: vi.fn(),
  mockGetUserInfo: vi.fn(),
  mockPublishView: vi.fn(),
  mockOpenView: vi.fn(),
}));

const { mockCreateClassifier, mockClassify } = vi.hoisted(() => ({
  mockCreateClassifier: vi.fn(),
  mockClassify: vi.fn(),
}));

vi.mock("./utils/slack-client", async () => {
  const actual = await vi.importActual<typeof SlackClientModule>("./utils/slack-client");
  return {
    ...actual,
    verifySlackSignature: mockVerifySlackSignature,
    getChannelInfo: mockGetChannelInfo,
    getThreadMessages: mockGetThreadMessages,
    getMessageByTimestamp: mockGetMessageByTimestamp,
    postMessage: mockPostMessage,
    updateMessage: mockUpdateMessage,
    addReaction: mockAddReaction,
    getUserInfo: mockGetUserInfo,
    publishView: mockPublishView,
    openView: mockOpenView,
  };
});

vi.mock("./classifier", () => ({
  createClassifier: mockCreateClassifier,
}));

import app from "./index";
import { clearLocalCache } from "./classifier/repos";

function createMockKV() {
  const store = new Map<string, string>();

  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({
      keys: [],
      list_complete: true,
      cursor: "",
    })),
  };
}

function makeEnv(repos = [DEFAULT_REPO]): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    CONTROL_PLANE: {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();

        if (url.includes("/repos")) {
          return new Response(JSON.stringify({ repos }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/model-preferences")) {
          return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-1", status: "created" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/sessions/existing-session")) {
          return new Response(JSON.stringify({ id: "existing-session", status: "active" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.endsWith("/sessions/stale-session")) {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/prompt")) {
          return new Response(JSON.stringify({ messageId: "msg-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ ok: true, url, body: init?.body ?? null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    SLACK_INVESTIGATE_REACTION: "inspect-investigate",
    ANTHROPIC_API_KEY: "test-key",
    LOG_LEVEL: "error",
  };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

function makeEventRequest(payload: object): Request {
  return new Request("http://localhost/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: JSON.stringify(payload),
  });
}

describe("POST /events reaction handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockCreateClassifier.mockReturnValue({ classify: mockClassify });
    mockClassify.mockResolvedValue({
      repo: DEFAULT_REPO,
      confidence: "high",
      reasoning: "Matched alert repository.",
      needsClarification: false,
    });
    mockGetChannelInfo.mockResolvedValue({
      ok: true,
      channel: {
        id: "C_ALERTS",
        name: "alerts",
        topic: { value: "Production alerts" },
      },
    });
    mockGetThreadMessages.mockResolvedValue({
      ok: true,
      messages: [{ ts: "111.222", text: "CPU spike on api", user: "U_ALERT" }],
    });
    mockGetMessageByTimestamp.mockResolvedValue({
      ok: true,
      message: { ts: "111.222", text: "CPU spike on api", user: "U_ALERT" },
    });
    mockPostMessage.mockResolvedValue({ ok: true, ts: "post-1" });
    mockUpdateMessage.mockResolvedValue({ ok: true });
    mockAddReaction.mockResolvedValue({ ok: true });
    mockGetUserInfo.mockImplementation(async (_token: string, userId: string) => ({
      ok: true,
      user: {
        id: userId,
        name: userId === "U_TRIGGER" ? "alice" : "alerts-bot",
        profile: {
          display_name: userId === "U_TRIGGER" ? "Alice" : "",
        },
      },
    }));
  });

  it("creates a session from a root-message reaction", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-1",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    const response = await app.fetch(makeEventRequest(payload), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    const createCall = controlPlaneFetch.mock.calls.find(([input]) =>
      String(input).endsWith("/sessions")
    );
    expect(createCall).toBeTruthy();
    const createBody = JSON.parse(String((createCall?.[1] as RequestInit).body)) as {
      title: string;
    };
    expect(createBody.title).toContain("Slack alert: CPU spike on api");

    const promptCall = controlPlaneFetch.mock.calls.find(([input]) =>
      String(input).includes("/sessions/session-1/prompt")
    );
    expect(promptCall).toBeTruthy();
    const promptBody = JSON.parse(String((promptCall?.[1] as RequestInit).body)) as {
      content: string;
      callbackContext: {
        threadTs: string;
        reactionMessageTs?: string;
      };
    };
    expect(promptBody.content).toContain("Investigate the Slack alert below.");
    expect(promptBody.content).toContain("Triggered by: Alice");
    expect(promptBody.content).toContain("Primary alert message:\nCPU spike on api");
    expect(promptBody.callbackContext.threadTs).toBe("111.222");
    expect(promptBody.callbackContext.reactionMessageTs).toBe("111.222");

    expect(mockUpdateMessage).toHaveBeenCalledOnce();
    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C_ALERTS", "111.222", "eyes");
    expect((env.SLACK_KV as unknown as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      "thread:C_ALERTS:111.222",
      "json"
    );
  });

  it("acknowledges an existing mapped session instead of creating a new one", async () => {
    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (key: string, value: string) => Promise<void> }).put(
      "thread:C_ALERTS:111.222",
      JSON.stringify({
        sessionId: "existing-session",
        repoId: DEFAULT_REPO.id,
        repoFullName: DEFAULT_REPO.fullName,
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
      })
    );
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-2",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      controlPlaneFetch.mock.calls.filter(([input]) => String(input).endsWith("/sessions"))
    ).toHaveLength(0);
    expect(
      controlPlaneFetch.mock.calls.filter(([input]) => String(input).includes("/prompt"))
    ).toHaveLength(0);
    expect(mockPostMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C_ALERTS",
      expect.stringContaining("An investigation already exists"),
      { thread_ts: "111.222" }
    );
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("uses the root thread when the reaction targets a reply", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    mockGetMessageByTimestamp.mockResolvedValue({
      ok: true,
      message: {
        ts: "222.333",
        text: "The API error rate is climbing",
        thread_ts: "111.222",
        user: "U_ALERT",
      },
    });
    mockGetThreadMessages.mockResolvedValue({
      ok: true,
      messages: [
        { ts: "111.222", text: "API latency alert", user: "U_ALERT" },
        { ts: "222.333", text: "The API error rate is climbing", user: "U_ALERT" },
      ],
    });

    const payload = {
      type: "event_callback",
      event_id: "evt-3",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_REPLY",
          ts: "222.333",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    const promptCall = controlPlaneFetch.mock.calls.find(([input]) =>
      String(input).includes("/sessions/session-1/prompt")
    );
    const promptBody = JSON.parse(String((promptCall?.[1] as RequestInit).body)) as {
      callbackContext: { threadTs: string; reactionMessageTs?: string };
      content: string;
    };
    expect(promptBody.callbackContext.threadTs).toBe("111.222");
    expect(promptBody.callbackContext.reactionMessageTs).toBe("222.333");
    expect(promptBody.content).toContain("Primary alert message:\nThe API error rate is climbing");
    expect(promptBody.content).toContain("Reacted thread reply:\nThe API error rate is climbing");
    expect(promptBody.content).toContain("[alerts-bot]");

    expect(mockPostMessage).toHaveBeenNthCalledWith(
      1,
      "xoxb-test",
      "C_REPLY",
      expect.stringContaining("Working on *acme/app*"),
      expect.objectContaining({ thread_ts: "111.222" })
    );
    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C_REPLY", "222.333", "eyes");
  });

  it("recreates the session when an existing thread mapping is stale", async () => {
    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (key: string, value: string) => Promise<void> }).put(
      "thread:C_ALERTS:111.222",
      JSON.stringify({
        sessionId: "stale-session",
        repoId: DEFAULT_REPO.id,
        repoFullName: DEFAULT_REPO.fullName,
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
      })
    );
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-stale",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      controlPlaneFetch.mock.calls.some(([input]) =>
        String(input).endsWith("/sessions/stale-session")
      )
    ).toBe(true);
    expect(
      controlPlaneFetch.mock.calls.some(([input]) => String(input).endsWith("/sessions"))
    ).toBe(true);
    expect(env.SLACK_KV.delete as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "thread:C_ALERTS:111.222"
    );
  });

  it("accepts reactions in any accessible channel", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-4",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ANY",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    expect(mockGetMessageByTimestamp).toHaveBeenCalledWith("xoxb-test", "C_ANY", "111.222");
    expect(mockPostMessage).toHaveBeenCalled();
  });

  it("ignores unsupported reaction emoji before fetching the message", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-ignore-reaction",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "eyes",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    expect(mockGetMessageByTimestamp).not.toHaveBeenCalled();
  });

  it("ignores non-message reaction items before fetching the message", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-ignore-item",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "file",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    expect(mockGetMessageByTimestamp).not.toHaveBeenCalled();
  });

  it("stops when Slack cannot fetch the reacted message", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    mockGetMessageByTimestamp.mockResolvedValue({
      ok: false,
      error: "channel_not_found",
    });
    const payload = {
      type: "event_callback",
      event_id: "evt-fetch-failure",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, ctx);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      controlPlaneFetch.mock.calls.some(([input]) => String(input).endsWith("/sessions"))
    ).toBe(false);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("deduplicates repeated Slack event deliveries", async () => {
    const env = makeEnv();
    const firstCtx = makeCtx();
    const secondCtx = makeCtx();
    const payload = {
      type: "event_callback",
      event_id: "evt-dedupe",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(payload), env, firstCtx);
    await flushWaitUntil(firstCtx);
    await app.fetch(makeEventRequest(payload), env, secondCtx);

    expect(secondCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("stores reaction clarification state and resumes it from repo selection", async () => {
    const env = makeEnv([DEFAULT_REPO, SECOND_REPO]);
    const eventCtx = makeCtx();
    mockClassify.mockResolvedValue({
      repo: null,
      confidence: "low",
      reasoning: "Need a repo selection.",
      needsClarification: true,
      alternatives: [SECOND_REPO],
    });

    const eventPayload = {
      type: "event_callback",
      event_id: "evt-clarify",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(eventPayload), env, eventCtx);
    await flushWaitUntil(eventCtx);

    const storedPending = await (
      env.SLACK_KV as unknown as { get: (key: string, type?: string) => Promise<unknown> }
    ).get("pending:C_ALERTS:111.222", "json");
    expect(storedPending).toMatchObject({
      kind: "reaction",
      reactionMessageTs: "111.222",
      rootThreadTs: "111.222",
    });

    const interactionPayload = {
      type: "block_actions",
      user: { id: "U_TRIGGER" },
      channel: { id: "C_ALERTS" },
      message: { ts: "selection-msg", thread_ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: SECOND_REPO.id },
        },
      ],
    };
    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(interactionPayload) }),
    });

    const interactionCtx = makeCtx();
    const response = await app.fetch(request, env, interactionCtx);
    expect(response.status).toBe(200);
    await flushWaitUntil(interactionCtx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    const createCall = controlPlaneFetch.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/sessions") &&
        JSON.parse(String((init as RequestInit).body)).repoName === "api"
    );
    expect(createCall).toBeTruthy();
    expect(mockAddReaction).toHaveBeenLastCalledWith("xoxb-test", "C_ALERTS", "111.222", "eyes");
  });

  it("rejects repo selection clicks from users other than the original requester", async () => {
    const env = makeEnv([DEFAULT_REPO, SECOND_REPO]);
    const eventCtx = makeCtx();
    mockClassify.mockResolvedValue({
      repo: null,
      confidence: "low",
      reasoning: "Need a repo selection.",
      needsClarification: true,
      alternatives: [SECOND_REPO],
    });

    const eventPayload = {
      type: "event_callback",
      event_id: "evt-clarify-mismatch",
      event: {
        type: "reaction_added",
        user: "U_TRIGGER",
        reaction: "inspect-investigate",
        item: {
          type: "message",
          channel: "C_ALERTS",
          ts: "111.222",
        },
      },
    };

    await app.fetch(makeEventRequest(eventPayload), env, eventCtx);
    await flushWaitUntil(eventCtx);

    const interactionPayload = {
      type: "block_actions",
      user: { id: "U_OTHER" },
      channel: { id: "C_ALERTS" },
      message: { ts: "selection-msg", thread_ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: SECOND_REPO.id },
        },
      ],
    };
    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(interactionPayload) }),
    });

    const interactionCtx = makeCtx();
    const response = await app.fetch(request, env, interactionCtx);
    expect(response.status).toBe(200);
    await flushWaitUntil(interactionCtx);

    const controlPlaneFetch = env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      controlPlaneFetch.mock.calls.some(([input]) => String(input).endsWith("/sessions"))
    ).toBe(false);
    expect(mockPostMessage).toHaveBeenLastCalledWith(
      "xoxb-test",
      "C_ALERTS",
      "Only the user who started this investigation can choose the repository.",
      { thread_ts: "111.222" }
    );
  });
});
