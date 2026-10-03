import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import { makeExecutionContext as makeCtx } from "./test-helpers";
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import type * as SlackModule from "@open-inspect/shared/slack";

const {
  mockVerifySlackSignature,
  mockPublishView,
  mockOpenView,
  mockGetUserInfo,
  mockMessagesCreate,
} = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockPublishView: vi.fn(),
  mockOpenView: vi.fn(),
  mockGetUserInfo: vi.fn(),
  mockMessagesCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

vi.mock("@open-inspect/shared/slack", async () => {
  const actual = await vi.importActual<typeof SlackModule>("@open-inspect/shared/slack");
  return {
    ...actual,
    verifySlackSignature: mockVerifySlackSignature,
    publishView: mockPublishView,
    openView: mockOpenView,
    getUserInfo: mockGetUserInfo,
  };
});

import app from "./index";
import { clearBotUserIdCache } from "./bot-identity";
import { clearLocalCache } from "./classifier/repos";
import { clearEnvironmentsLocalCache } from "./classifier/environments";
import { RepoClassifier } from "./classifier";

function createMockKV() {
  const store = new Map<string, string>();

  return {
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
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return {
        keys,
        list_complete: true,
        cursor: "",
      };
    }),
  };
}

function mockReposResponseBody(repos: Array<Record<string, unknown>>) {
  return {
    repos: repos.map((repo, index) => ({
      ...repo,
      id: typeof repo.id === "number" ? repo.id : index + 1,
      fullName:
        typeof repo.fullName === "string"
          ? repo.fullName
          : `${String(repo.owner)}/${String(repo.name)}`,
      description:
        repo.description === null || typeof repo.description === "string" ? repo.description : null,
      archived: typeof repo.archived === "boolean" ? repo.archived : false,
    })),
    cached: false,
    cachedAt: "2026-07-27T00:00:00.000Z",
  };
}

function makeEnv() {
  const controlPlaneFetch = vi.fn<ControlPlaneFetcher["fetch"]>();
  controlPlaneFetch.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/channel-bindings/slack/")) return Response.json({ teamId: null });
    if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
    if (url.includes("/repos")) {
      return new Response(
        JSON.stringify(
          mockReposResponseBody([
            {
              id: "acme/app",
              owner: "acme",
              name: "app",
              fullName: "acme/app",
              defaultBranch: "main",
              private: true,
            },
          ])
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const env = {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    SLACK_COMPLETION_QUEUE: {
      send: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: controlPlaneFetch,
    },
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    SERVICE_AUTH_SECRET: "test-secret",
    LOG_LEVEL: "error",
  };
  env satisfies Env;
  return env;
}

/** Build N numbered repos (acme/repo-001 …) for picker/suggestion tests. */
function buildNumberedRepos(count: number) {
  return Array.from({ length: count }, (_, idx) => {
    const number = String(idx + 1).padStart(3, "0");
    return {
      id: `acme/repo-${number}`,
      owner: "acme",
      name: `repo-${number}`,
      fullName: `acme/repo-${number}`,
      defaultBranch: "main",
      private: true,
    };
  });
}

/** Point CONTROL_PLANE.fetch at a fixed catalog and binding scope. */
function mockReposFetch(
  env: ReturnType<typeof makeEnv>,
  repos: Array<Record<string, unknown>>,
  teamId: string | null = null
) {
  env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/channel-bindings/slack/"))
      return Response.json(teamId ? { teamId, kind: "primary" } : { teamId: null });
    if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
    if (url.includes("/repos")) {
      return new Response(JSON.stringify(mockReposResponseBody(repos)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

const DEFAULT_MODEL_PREFERENCES_STATUS = 200;

function makeSessionEnv(
  order: string[] = [],
  responses: {
    session?: unknown;
    prompt?: unknown | unknown[];
    promptStatus?: number | number[];
    publicationStatus?: number;
    teamId?: string | null;
    modelPreferencesStatus?: number;
  } = {}
): ReturnType<typeof makeEnv> {
  const env = makeEnv();
  let promptResponseIndex = 0;
  env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/channel-bindings/slack/"))
      return Response.json(
        responses.teamId ? { teamId: responses.teamId, kind: "primary" } : { teamId: null }
      );
    if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
    if (new URL(url).pathname.endsWith("/artifacts")) {
      return Response.json({ artifacts: [] }, { status: responses.publicationStatus ?? 200 });
    }
    if (url.includes("/repos")) {
      order.push("repos");
      return new Response(
        JSON.stringify(
          mockReposResponseBody([
            {
              id: "acme/app",
              owner: "acme",
              name: "app",
              fullName: "acme/app",
              defaultBranch: "main",
              private: true,
            },
          ])
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.endsWith("/sessions")) {
      order.push("session");
      return new Response(
        JSON.stringify(responses.session ?? { sessionId: "session-1", status: "created" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (url.includes("/attachments")) {
      order.push("attachment");
      return new Response(JSON.stringify({ attachmentId: "att-1", mimeType: "image/png" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/prompt")) {
      order.push("prompt");
      const promptResponse = Array.isArray(responses.prompt)
        ? responses.prompt[promptResponseIndex++]
        : responses.prompt;
      const promptStatus = Array.isArray(responses.promptStatus)
        ? responses.promptStatus[promptResponseIndex - 1]
        : responses.promptStatus;
      return new Response(JSON.stringify(promptResponse ?? { messageId: "msg-1" }), {
        status: promptStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
      status: responses.modelPreferencesStatus ?? DEFAULT_MODEL_PREFERENCES_STATUS,
      headers: { "Content-Type": "application/json" },
    });
  });
  return env;
}

function mockSlackFetch(
  order: string[] = [],
  options: {
    threadMessages?: unknown[];
    threadRepliesError?: string;
    /** HTTP status for files.slack.com downloads (default 200 with bytes). */
    fileDownloadStatus?: number;
  } = {}
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("assistant.threads.setStatus")) {
      order.push("status");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("conversations.info")) {
      order.push("channelInfo");
      return new Response(
        JSON.stringify({
          ok: true,
          channel: { id: "C123", name: "eng", topic: { value: "" }, purpose: { value: "" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("auth.test")) {
      return new Response(JSON.stringify({ ok: true, user_id: "UBOT" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("users.info")) {
      const user = new URL(url).searchParams.get("user") ?? "UUNKNOWN";
      return new Response(
        JSON.stringify({
          ok: true,
          user: {
            id: user,
            name: user,
            profile: { display_name: user === "U123" ? "Ajan\n[Admin]" : user },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("conversations.replies")) {
      const payload = options.threadRepliesError
        ? { ok: false, error: options.threadRepliesError }
        : { ok: true, messages: options.threadMessages ?? [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("files.slack.com")) {
      order.push("filedownload");
      if (options.fileDownloadStatus && options.fileDownloadStatus !== 200) {
        return new Response("denied", { status: options.fileDownloadStatus });
      }
      return new Response(new Uint8Array(16).fill(1), { status: 200 });
    }

    if (url.includes("chat.postMessage")) {
      order.push("post");
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "222.333" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("chat.update")) {
      order.push("update");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("reactions.add")) {
      order.push("reaction");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected Slack fetch: ${url} ${JSON.stringify(init)}`);
  });
}

function statusFetchBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("assistant.threads.setStatus");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function startingStatusBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return statusFetchBodies(fetchMock).filter((body) => {
    const loadingMessages = body.loading_messages;
    return (
      body.status === "Starting..." &&
      Array.isArray(loadingMessages) &&
      loadingMessages[0] === "Starting..."
    );
  });
}

function slackApiBodies(
  fetchMock: { mock: { calls: readonly (readonly unknown[])[] } },
  method: string
) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes(method);
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function promptFetchBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.includes("/prompt");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function sessionFetchBodies(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => {
      const url = typeof input === "string" ? input : String(input);
      return url.endsWith("/sessions");
    })
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function slackEventRequest(event: Record<string, unknown>, eventId = crypto.randomUUID()): Request {
  return new Request("http://localhost/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: JSON.stringify({
      type: "event_callback",
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      team_id: "T123",
      event,
    }),
  });
}

function slackInteractionRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
}

describe("POST /events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBotUserIdCache();
    clearLocalCache();
    clearEnvironmentsLocalCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockGetUserInfo.mockResolvedValue({ ok: false, error: "user_not_found" });
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_test",
          name: "classify_target",
          input: {
            targetId: "acme/app",
            confidence: "high",
            reasoning: "The request applies to the available repository.",
            alternatives: [],
          },
        },
      ],
    });
  });

  it("publishes App Home when the home tab is opened", async () => {
    mockPublishView.mockResolvedValue({ ok: true });
    const env = makeEnv();
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_home_opened",
        tab: "home",
        user: "U123",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    expect(mockPublishView).toHaveBeenCalledOnce();
    const [token, userId, view] = mockPublishView.mock.calls[0];
    expect(token).toBe("xoxb-test");
    expect(userId).toBe("U123");
    expect(view).toEqual(
      expect.objectContaining({
        type: "home",
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "section",
            text: expect.objectContaining({
              text: "Configure your Open-Inspect preferences below.",
            }),
          }),
          expect.objectContaining({
            type: "section",
            text: expect.objectContaining({
              text: expect.stringContaining("*Branch by repository*"),
            }),
          }),
        ]),
      })
    );
  });

  it("does not dispatch app mentions without a user", async () => {
    const slackFetch = mockSlackFetch([]);
    const env = makeSessionEnv([]);
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> fix the auth tests",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(env.CONTROL_PLANE.fetch).not.toHaveBeenCalled();
    expect(mockGetUserInfo).not.toHaveBeenCalled();
    expect(slackFetch).not.toHaveBeenCalled();
    expect((env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith(
      expect.stringMatching(/^event:/),
      "1",
      { expirationTtl: 3600 }
    );

    slackFetch.mockRestore();
  });

  it("sets Starting status for a new app mention before session creation", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { teamId: "team-a" });
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> fix the auth tests",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);
    await flushWaitUntil(ctx, 1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(4);

    expect(statusFetchBodies(slackFetch)).toContainEqual({
      channel_id: "C123",
      thread_ts: "111.222",
      status: "Starting...",
      loading_messages: ["Starting..."],
    });
    expect(startingStatusBodies(slackFetch)).toHaveLength(3);
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("session"));
    expect(mockGetUserInfo).toHaveBeenCalledOnce();

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    expect(postBodies.some((body) => String(body.text).includes("Session started!"))).toBe(false);

    const sessionBodies = sessionFetchBodies(env.CONTROL_PLANE.fetch);
    expect(sessionBodies).toEqual([expect.objectContaining({ teamId: "team-a" })]);
    for (const resource of ["repos", "environments"]) {
      const catalogReads = env.CONTROL_PLANE.fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === `/${resource}`
      );
      expect(catalogReads).toHaveLength(1);
      for (const [url, init] of catalogReads) {
        expect(String(url)).toBe(`https://internal/${resource}?channel=slack%3AC123`);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-OpenInspect-Actor")).toBe("slack:U123");
        expect(headers.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
      }
    }
    expect(sessionBodies[0]).not.toHaveProperty("title");
    expect((env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith(
      "thread:C123:111.222",
      expect.any(String),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );

    const updateBodies = slackApiBodies(slackFetch, "chat.update");
    expect(updateBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "C123",
          ts: "222.333",
          text: "Starting work...",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "actions",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  type: "button",
                  text: { type: "plain_text", text: "View Session" },
                  url: "https://app.test/session/session-1",
                  action_id: "view_session",
                }),
              ]),
            }),
          ]),
        }),
      ])
    );

    slackFetch.mockRestore();
  });

  it("resolves the actor once across clarification and selection", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeEnv();
    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: { id: "U123", name: "ajan", profile: { display_name: "Ajan" } },
    });
    env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/channel-bindings/slack/"))
        return Response.json({ teamId: "team-a", kind: "primary" });
      if (url.includes("/environments")) return Response.json({ environments: [], total: 0 });
      if (url.includes("/repos")) {
        return new Response(
          JSON.stringify(
            mockReposResponseBody([
              { owner: "acme", name: "web", defaultBranch: "main", private: true },
              { owner: "acme", name: "api", defaultBranch: "main", private: true },
              { owner: "acme", name: "docs", defaultBranch: "main", private: true },
            ])
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("/integration-settings/slack")) {
        return new Response(
          JSON.stringify({
            settings: {
              defaults: {
                routingRules: [
                  { keyword: "frontend", target: "acme/web" },
                  { keyword: "backend", target: "acme/api" },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/sessions")) {
        order.push("session");
        return new Response(JSON.stringify({ sessionId: "session-1", status: "created" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/prompt")) {
        order.push("prompt");
        return new Response(JSON.stringify({ messageId: "msg-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const ctx = makeCtx();
    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> frontend backend help",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    const clarification = postBodies.find((body) =>
      String(body.text).includes("I couldn't determine which target")
    );

    expect(clarification).toEqual(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "section",
            accessory: expect.objectContaining({
              type: "static_select",
              action_id: "select_repo",
              options: expect.arrayContaining([
                expect.objectContaining({ value: "acme/web" }),
                expect.objectContaining({ value: "acme/api" }),
                expect.objectContaining({ value: "acme/docs" }),
              ]),
            }),
          }),
        ]),
      })
    );
    const clarificationBlocks = clarification?.blocks;
    if (!Array.isArray(clarificationBlocks)) throw new Error("expected clarification blocks");
    const pickerBlock = clarificationBlocks.find(
      (block): block is Record<string, unknown> =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as Record<string, unknown>).block_id === "string" &&
        String((block as Record<string, unknown>).block_id).startsWith("target_picker:")
    );
    if (!pickerBlock) throw new Error("expected request-bound picker block");
    const pickerBlockId = String(pickerBlock.block_id);
    const requestId = pickerBlockId.slice("target_picker:".length);

    expect(mockGetUserInfo).not.toHaveBeenCalled();
    await expect(
      (env.SLACK_KV as unknown as { get: (key: string, type: string) => Promise<unknown> }).get(
        `pending:${requestId}`,
        "json"
      )
    ).resolves.toEqual(
      expect.objectContaining({
        requestId,
        teamId: "team-a",
        channel: "C123",
        threadTs: "111.222",
        message: "frontend backend help",
        userId: "U123",
        unattributedPrompt: { forwardedMessages: [] },
        classification: {
          confidence: "medium",
          source: "routing_rule",
        },
      })
    );

    const selectionCtx = makeCtx();
    const selectionResponse = await app.fetch(
      new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=test",
          "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: new URLSearchParams({
          payload: JSON.stringify({
            type: "block_actions",
            user: { id: "U123" },
            channel: { id: "C123" },
            message: { ts: "111.222" },
            actions: [
              {
                action_id: "select_repo",
                block_id: pickerBlockId,
                selected_option: { value: "acme/web" },
              },
            ],
          }),
        }),
      }),
      env,
      selectionCtx
    );

    expect(selectionResponse.status).toBe(200);
    await flushWaitUntil(selectionCtx);
    expect(mockGetUserInfo).toHaveBeenCalledOnce();
    expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([
      expect.objectContaining({ teamId: "team-a" }),
    ]);
    for (const resource of ["repos", "environments"]) {
      const catalogReads = env.CONTROL_PLANE.fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === `/${resource}`
      );
      expect(catalogReads).toHaveLength(resource === "repos" ? 3 : 2);
      for (const [url, init] of catalogReads) {
        expect(String(url)).toBe(`https://internal/${resource}?channel=slack%3AC123`);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-OpenInspect-Actor")).toBe("slack:U123");
        expect(headers.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
      }
    }
    expect(
      env.CONTROL_PLANE.fetch.mock.calls.filter(([url]) =>
        String(url).includes("/channel-bindings/slack/C123")
      )
    ).toHaveLength(2);
    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("[Ajan (U123)]: frontend backend help"),
      }),
    ]);

    slackFetch.mockRestore();
  });

  it("treats a malformed session creation response as a creation failure", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { session: { status: "created" } });
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> fix the auth tests",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(order).toContain("session");
    expect(order).not.toContain("prompt");
    expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "C123",
          thread_ts: "111.222",
          text: "Sorry, I couldn't create a session. Please try again.",
        }),
      ])
    );
    const threadMappingWrite = (
      env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }
    ).put.mock.calls.find(([key]) => key === "thread:C123:111.222");
    expect(threadMappingWrite).toBeUndefined();

    slackFetch.mockRestore();
  });

  it("treats a malformed prompt response as a prompt delivery failure", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { prompt: {} });
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> fix the auth tests",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(order).toContain("session");
    expect(order).toContain("prompt");
    expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "C123",
          thread_ts: "111.222",
          text: "Session created but failed to send prompt. Please try again.",
        }),
      ])
    );
    const threadMappingWrite = (
      env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }
    ).put.mock.calls.find(([key]) => key === "thread:C123:111.222");
    expect(threadMappingWrite).toBeUndefined();

    slackFetch.mockRestore();
  });

  it("sets Starting status for a direct message", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "message",
        text: "fix the auth tests",
        user: "U123",
        channel: "D123",
        ts: "444.555",
        channel_type: "im",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(statusFetchBodies(slackFetch)).toContainEqual({
      channel_id: "D123",
      thread_ts: "444.555",
      status: "Starting...",
      loading_messages: ["Starting..."],
    });
    expect(startingStatusBodies(slackFetch)).toHaveLength(3);
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("session"));
    expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([
      expect.objectContaining({ teamId: null }),
    ]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/channel-bindings/slack/D123",
      expect.anything()
    );
    for (const resource of ["repos", "environments"]) {
      const catalogReads = env.CONTROL_PLANE.fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === `/${resource}`
      );
      expect(catalogReads).toHaveLength(1);
      for (const [url, init] of catalogReads) {
        expect(String(url)).toBe(`https://internal/${resource}?channel=slack%3AD123`);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-OpenInspect-Actor")).toBe("slack:U123");
        expect(headers.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
      }
    }

    slackFetch.mockRestore();
  });

  it.each([404, 503, "malformed", "network"] as const)(
    "refuses a new request before classification when binding lookup fails: %s",
    async (failure) => {
      const slackFetch = mockSlackFetch();
      const classify = vi.spyOn(RepoClassifier.prototype, "classify");
      const env = makeSessionEnv();
      env.CONTROL_PLANE.fetch.mockImplementation(async () => {
        if (failure === "network") throw new Error("offline");
        return failure === "malformed"
          ? Response.json({ teamId: null, kind: "primary" })
          : new Response(null, { status: failure });
      });
      const ctx = makeCtx();
      await app.fetch(
        slackEventRequest({
          type: "message",
          channel_type: "im",
          channel: "D123",
          text: "Fix it",
          user: "U123",
          ts: "111.222",
        }),
        env,
        ctx
      );
      await flushWaitUntil(ctx);
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledOnce();
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
        "https://internal/channel-bindings/slack/D123",
        expect.objectContaining({
          headers: expect.objectContaining({ "X-OpenInspect-Service": "slack-bot" }),
        })
      );
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({
          channel: "D123",
          thread_ts: "111.222",
          text: expect.stringContaining(failure === 404 ? "bind" : "verify"),
        }),
      ]);
      classify.mockRestore();
      slackFetch.mockRestore();
    }
  );

  describe.each(["app_mention", "message"] as const)("mapped %s follow-up scope", (type) => {
    it.each([
      ["rebound", "team-a"],
      ["unbound", "team-a"],
      ["missing", "team-a"],
      ["malformed", "team-a"],
      ["unavailable", "team-a"],
      ["network", "team-a"],
      ["rebound", null],
      ["rebound", undefined],
    ] as const)(
      "tombstones before Slack reads when binding is %s and stored team is %s",
      async (failure, teamId) => {
        const channel = type === "message" ? "D123" : "C123";
        const slackFetch = mockSlackFetch();
        const classify = vi.spyOn(RepoClassifier.prototype, "classify");
        const env = makeSessionEnv();
        await env.SLACK_KV.put(
          `thread:${channel}:111.222`,
          JSON.stringify({
            sessionId: "team-a-session",
            teamId,
            repoId: "acme/app",
            repoFullName: "acme/app",
            model: "anthropic/claude-haiku-4-5",
            createdAt: 1,
            lastPromptTs: "111.222",
          })
        );
        env.CONTROL_PLANE.fetch.mockImplementation(async () => {
          if (failure === "network") throw new Error("offline");
          if (failure === "missing") return new Response(null, { status: 404 });
          if (failure === "unavailable") return new Response(null, { status: 503 });
          return Response.json(
            failure === "rebound"
              ? { teamId: "team-b", kind: "source" }
              : failure === "unbound"
                ? { teamId: null }
                : { teamId: "team-a" }
          );
        });
        const ctx = makeCtx();
        await app.fetch(
          slackEventRequest({
            type,
            channel,
            channel_type: type === "message" ? "im" : undefined,
            text: "<@B123> confidential team-b follow-up",
            user: "U123",
            ts: "333.444",
            thread_ts: "111.222",
            files: [
              {
                id: "F1",
                name: "secret.png",
                mimetype: "image/png",
                url_private: "https://files.slack.com/secret.png",
                size: 16,
              },
            ],
          }),
          env,
          ctx
        );
        await flushWaitUntil(ctx);
        expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledOnce();
        expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
          `https://internal/channel-bindings/slack/${channel}`,
          expect.anything()
        );
        expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
        expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
        expect(classify).not.toHaveBeenCalled();
        expect(mockGetUserInfo).not.toHaveBeenCalled();
        expect(
          slackFetch.mock.calls.every(([url]) => String(url).includes("chat.postMessage"))
        ).toBe(true);
        expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
          expect.objectContaining({
            channel,
            thread_ts: "111.222",
            text: "this session is no longer available from this channel",
          }),
        ]);
        expect(await env.SLACK_KV.get(`thread-closed:${channel}:111.222:team-a-session`)).toBe("1");
        expect(await env.SLACK_KV.get(`thread:${channel}:111.222`, "json")).toMatchObject({
          closed: true,
        });
        classify.mockRestore();
        slackFetch.mockRestore();
      }
    );
  });

  it.each(["prompt", "attachment"] as const)(
    "tombstones a matching mapped thread if %s admission observes a rebind",
    async (write) => {
      const slackFetch = mockSlackFetch();
      const env = makeSessionEnv([], { teamId: "team-a" });
      const dispatch = env.CONTROL_PLANE.fetch.getMockImplementation()!;
      let uploads = 0;
      env.CONTROL_PLANE.fetch.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(write === "prompt" ? "/prompt" : "/attachments")) {
          expect(url.searchParams.get("channel")).toBe("slack:C123");
          if (write === "attachment" && uploads++ === 0) {
            return Response.json({ attachmentId: "att-1", mimeType: "image/png" }, { status: 201 });
          }
          return Response.json({ code: "slack_channel_scope_denied" }, { status: 403 });
        }
        return dispatch(input, init);
      });
      await env.SLACK_KV.put(
        "thread:C123:111.222",
        JSON.stringify({
          sessionId: "team-a-session",
          teamId: "team-a",
          repoId: "acme/app",
          repoFullName: "acme/app",
          model: "anthropic/claude-haiku-4-5",
          createdAt: 1,
        })
      );
      const ctx = makeCtx();
      await app.fetch(
        slackEventRequest({
          type: "app_mention",
          channel: "C123",
          text: "<@B123> follow up",
          user: "U123",
          ts: "333.444",
          thread_ts: "111.222",
          files:
            write === "attachment"
              ? ["F1", "F2"].map((id) => ({
                  id,
                  name: "secret.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/secret.png",
                  size: 16,
                }))
              : [],
        }),
        env,
        ctx
      );
      await flushWaitUntil(ctx);
      expect(await env.SLACK_KV.get("thread-closed:C123:111.222:team-a-session")).toBe("1");
      if (write === "attachment") expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toContainEqual(
        expect.objectContaining({ text: "this session is no longer available from this channel" })
      );
      slackFetch.mockRestore();
    }
  );

  it("allows a mapped team follow-up only after reading the current binding", async () => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv([], { teamId: "team-a" });
    await env.SLACK_KV.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "team-a-session",
        teamId: "team-a",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: 1,
      })
    );
    const ctx = makeCtx();
    await app.fetch(
      slackEventRequest({
        type: "app_mention",
        channel: "C123",
        text: "<@B123> follow up",
        user: "U123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );
    await flushWaitUntil(ctx);
    expect(env.CONTROL_PLANE.fetch.mock.calls[0][0]).toBe(
      "https://internal/channel-bindings/slack/C123"
    );
    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
    expect(await env.SLACK_KV.get("thread-closed:C123:111.222:team-a-session")).toBeNull();
    slackFetch.mockRestore();
  });

  it("reopens a closed thread once its binding and visibility allow posting again", async () => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv([], { teamId: "team-a" });
    await env.SLACK_KV.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "team-a-session",
        teamId: "team-a",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: 1,
        closed: true,
      })
    );
    await env.SLACK_KV.put("thread-closed:C123:111.222:team-a-session", "1");
    await env.SLACK_KV.put("thread-closed:C123:111.222:team-a-session:notice", "1");
    const ctx = makeCtx();
    await app.fetch(
      slackEventRequest({
        type: "app_mention",
        channel: "C123",
        text: "<@B123> follow up",
        user: "U123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );
    await flushWaitUntil(ctx);
    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
    expect(await env.SLACK_KV.get("thread-closed:C123:111.222:team-a-session")).toBeNull();
    expect(await env.SLACK_KV.get("thread-closed:C123:111.222:team-a-session:notice")).toBeNull();
    expect(await env.SLACK_KV.get("thread:C123:111.222", "json")).not.toHaveProperty("closed");
    expect(slackApiBodies(slackFetch, "chat.postMessage")).not.toContainEqual(
      expect.objectContaining({ text: "this session is no longer available from this channel" })
    );
    slackFetch.mockRestore();
  });

  it.each([
    ["the channel is bound to another team", { teamId: "team-b" }],
    ["the session cannot post to the channel", { teamId: "team-a", publicationStatus: 403 }],
  ] as const)("keeps a closed thread closed while %s", async (_reason, responses) => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv([], responses);
    await env.SLACK_KV.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "team-a-session",
        teamId: "team-a",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: 1,
        closed: true,
      })
    );
    await env.SLACK_KV.put("thread-closed:C123:111.222:team-a-session", "1");
    const ctx = makeCtx();
    await app.fetch(
      slackEventRequest({
        type: "app_mention",
        channel: "C123",
        text: "<@B123> follow up",
        user: "U123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );
    await flushWaitUntil(ctx);
    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
    expect(await env.SLACK_KV.get("thread-closed:C123:111.222:team-a-session")).toBe("1");
    expect(slackApiBodies(slackFetch, "chat.postMessage")).toContainEqual(
      expect.objectContaining({ text: "this session is no longer available from this channel" })
    );
    slackFetch.mockRestore();
  });

  it("adopts combined inline overrides as a new direct-message session's defaults", async () => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv();
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "message",
        text: "!model anthropic/claude-haiku-4-5 !reasoning high fix the auth tests",
        user: "U123",
        channel: "D123",
        ts: "444.555",
        channel_type: "im",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    // The flags configure the session itself, so later turns in the thread
    // inherit them instead of reverting to the App Home default.
    expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([
      expect.objectContaining({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
      }),
    ]);
    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0]).toMatchObject({
      callbackContext: {
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
      },
    });
    expect(promptBodies[0]).not.toHaveProperty("model");
    expect(promptBodies[0]).not.toHaveProperty("reasoningEffort");
    expect(String(promptBodies[0].content)).toContain("fix the auth tests");
    expect(String(promptBodies[0].content)).not.toContain("!model");
    expect(String(promptBodies[0].content)).not.toContain("!reasoning");
    // The thread mapping is what later follow-ups resolve against, so the
    // flagged model has to land there for the defaults to actually stick.
    await expect(
      (env.SLACK_KV as unknown as { get: (key: string, type: string) => Promise<unknown> }).get(
        "thread:D123:444.555",
        "json"
      )
    ).resolves.toEqual(
      expect.objectContaining({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
      })
    );

    slackFetch.mockRestore();
  });

  it("sets Starting status for follow-up prompts in existing threads", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, {
      threadMessages: [
        {
          type: "message",
          text: "The latest commit is:\n\n- `3b23cf7` - `Add Linear integration guide (#645)`",
          bot_id: "B123",
          ts: "222.333",
        },
      ],
    });
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
        createdAt: Date.now(),
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> now add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(statusFetchBodies(slackFetch)).toContainEqual({
      channel_id: "C123",
      thread_ts: "111.222",
      status: "Starting...",
      loading_messages: ["Starting..."],
    });
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("prompt"));
    expect(order).not.toContain("session");

    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0].content).toContain("now add coverage");
    expect(promptBodies[0].content).toContain("[U123]: now add coverage");
    expect(promptBodies[0].content).toContain("Slack channel context");
    expect(promptBodies[0].content).not.toContain("Context from the Slack thread");
    expect(promptBodies[0].content).not.toContain("The latest commit is");
    expect(
      slackFetch.mock.calls.some(
        ([input]) =>
          String(input).includes("conversations.replies") && String(input).includes("limit=200")
      )
    ).toBe(false);
    // Legacy mappings without lastPromptTs get stamped so the next follow-up
    // can scope interim thread context.
    await expect(
      (env.SLACK_KV as unknown as { get: (key: string, type: string) => Promise<unknown> }).get(
        "thread:C123:111.222",
        "json"
      )
    ).resolves.toEqual(expect.objectContaining({ lastPromptTs: "333.444" }));

    slackFetch.mockRestore();
  });

  it("strips combined model and reasoning flags from an existing-thread follow-up", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
      get: (key: string, type: string) => Promise<unknown>;
    };
    const mapping = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "max",
      createdAt: Date.now(),
    };
    await kv.put("thread:C123:111.222", JSON.stringify(mapping));
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> !model:anthropic/claude-haiku-4-5 !reasoning high now add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0]).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      callbackContext: {
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
      },
    });
    expect(String(promptBodies[0].content)).toContain("[U123]: now add coverage");
    expect(String(promptBodies[0].content)).not.toContain("!model");
    expect(String(promptBodies[0].content)).not.toContain("!reasoning");
    await expect(kv.get("thread:C123:111.222", "json")).resolves.toEqual(
      expect.objectContaining({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
      })
    );

    slackFetch.mockRestore();
  });

  it("uses an enabled fallback model for a reasoning-only existing-thread override", async () => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv();
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
    };
    await kv.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "xhigh",
        createdAt: Date.now(),
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> !reasoning:max add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([
      expect.objectContaining({
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
        callbackContext: expect.objectContaining({
          model: "anthropic/claude-haiku-4-5",
          reasoningEffort: "max",
        }),
      }),
    ]);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/model-preferences?strict=true",
      expect.objectContaining({ method: "GET" })
    );

    slackFetch.mockRestore();
  });

  it("does not admit model overrides from fallback preferences", async () => {
    const slackFetch = mockSlackFetch();
    const env = makeSessionEnv([], { modelPreferencesStatus: 503 });
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
    };
    await kv.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "max",
        createdAt: Date.now(),
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> !model:anthropic/claude-haiku-4-5 add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);
    expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(0);
    expect(slackApiBodies(slackFetch, "chat.postMessage")).toContainEqual(
      expect.objectContaining({
        text: "Model preferences are temporarily unavailable. Please try again.",
        thread_ts: "111.222",
      })
    );

    slackFetch.mockRestore();
  });

  it("preserves an existing session mapping after a transient prompt failure", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { prompt: {} });
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
      delete: ReturnType<typeof vi.fn>;
      get: (key: string, type: string) => Promise<unknown>;
    };
    const mapping = {
      sessionId: "session-1",
      repoId: "acme/app",
      repoFullName: "acme/app",
      model: "anthropic/claude-haiku-4-5",
      createdAt: Date.now(),
    };
    await kv.put("thread:C123:111.222", JSON.stringify(mapping));
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> now add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(order).not.toContain("session");
    expect(kv.delete).not.toHaveBeenCalledWith("thread:C123:111.222");
    await expect(kv.get("thread:C123:111.222", "json")).resolves.toEqual(mapping);
    expect(slackApiBodies(slackFetch, "chat.postMessage")).toContainEqual(
      expect.objectContaining({ text: "Sorry, I couldn't send your follow-up. Please try again." })
    );
    expect(
      slackFetch.mock.calls.some(
        ([input]) =>
          String(input).includes("conversations.replies") && String(input).includes("limit=200")
      )
    ).toBe(false);

    slackFetch.mockRestore();
  });

  it.each([
    [404, 404, true],
    [403, 200, false],
    [404, 200, false],
    [404, 503, false],
  ] as const)(
    "closes a mapping only with channel-wide denial (prompt %s, publication %s, closed %s)",
    async (promptStatus, publicationStatus, closed) => {
      const slackFetch = mockSlackFetch();
      const classify = vi.spyOn(RepoClassifier.prototype, "classify");
      const env = makeSessionEnv([], {
        prompt: [{ error: "Denied" }, { messageId: "authorized-prompt" }],
        promptStatus: [promptStatus, 200],
        publicationStatus,
        teamId: "team-a",
      });
      const mapping = {
        sessionId: "stale-session",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "high",
        teamId: "team-a",
        createdAt: Date.now(),
      };
      await env.SLACK_KV.put("thread:C123:111.222", JSON.stringify(mapping));
      const event = {
        type: "app_mention",
        text: "<@B123> now add coverage",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      };
      const ctx = makeCtx();
      expect((await app.fetch(slackEventRequest(event), env, ctx)).status).toBe(200);
      await flushWaitUntil(ctx);
      expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(1);
      await expect(env.SLACK_KV.get("thread:C123:111.222", "json")).resolves.toEqual(
        closed ? expect.objectContaining({ ...mapping, closed: true }) : mapping
      );
      const publication = env.CONTROL_PLANE.fetch.mock.calls.filter(([url]) =>
        String(url).includes("/artifacts")
      );
      expect(publication).toHaveLength(promptStatus === 404 ? 1 : 0);
      if (promptStatus === 404) {
        const [url, init] = publication[0]!;
        expect(new URL(String(url)).pathname).toBe("/sessions/stale-session/artifacts");
        expect(new URL(String(url)).searchParams.get("channel")).toBe("slack:C123");
        expect(new URL(String(url)).searchParams.get("purpose")).toBe("slack-post");
        expect(new Headers(init?.headers).get("X-OpenInspect-Actor")).toBeNull();
      }
      const reply =
        promptStatus === 403
          ? "you do not have access to this session"
          : "this session is no longer available from this channel";
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual([
        expect.objectContaining({ channel: "C123", thread_ts: "111.222", text: reply }),
      ]);
      const requestCount = env.CONTROL_PLANE.fetch.mock.calls.length;
      for (const text of closed ? ["<@B123> again", "<@B123>"] : ["<@B123> authorized follow-up"]) {
        const next = makeCtx();
        await app.fetch(
          slackEventRequest({ ...event, text, user: "U456", ts: "444.555" }),
          env,
          next
        );
        await flushWaitUntil(next);
      }
      if (closed) {
        // Each reply re-checks the closure live; denied publication keeps it closed.
        expect(
          env.CONTROL_PLANE.fetch.mock.calls
            .slice(requestCount)
            .map(([url]) => new URL(String(url)).pathname)
        ).toEqual([
          "/channel-bindings/slack/C123",
          "/sessions/stale-session/artifacts",
          "/channel-bindings/slack/C123",
          "/sessions/stale-session/artifacts",
        ]);
        expect(slackApiBodies(slackFetch, "chat.postMessage").map((body) => body.text)).toEqual([
          reply,
          reply,
          reply,
        ]);
      } else {
        expect(promptFetchBodies(env.CONTROL_PLANE.fetch)).toHaveLength(2);
        const [url, init] = env.CONTROL_PLANE.fetch.mock.calls.at(-1)!;
        expect(new URL(String(url)).pathname).toBe("/sessions/stale-session/prompt");
        expect(new URL(String(url)).searchParams.get("channel")).toBe("slack:C123");
        expect(new Headers(init?.headers).get("X-OpenInspect-Actor")).toBe("slack:U456");
        const stored = await env.SLACK_KV.get<Record<string, unknown>>(
          "thread:C123:111.222",
          "json"
        );
        expect(stored).toMatchObject(mapping);
        expect(stored?.closed).not.toBe(true);
      }
      expect(sessionFetchBodies(env.CONTROL_PLANE.fetch)).toEqual([]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(
        env.CONTROL_PLANE.fetch.mock.calls.some(([url]) =>
          /\/(repos|environments|integration-settings)(?:\/|\?|$)/.test(String(url))
        )
      ).toBe(false);
      expect(
        slackFetch.mock.calls.some(
          ([url]) =>
            String(url).includes("conversations.replies") && String(url).includes("limit=200")
        )
      ).toBe(false);
      classify.mockRestore();
      slackFetch.mockRestore();
    }
  );

  it("forwards interim human messages on follow-ups to an existing session", async () => {
    const order: string[] = [];
    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: { id: "U123", name: "ajan", profile: { display_name: "Ajan\n[Admin]" } },
    });
    const slackFetch = mockSlackFetch(order, {
      threadMessages: [
        { type: "message", text: "<@B123> do this action", user: "U123", ts: "111.222" },
        { type: "message", text: "what do you think?", user: "U123", ts: "222.000" },
        { type: "message", text: "i think we should do x", user: "U789", ts: "225.000" },
        { type: "message", text: "Working on acme/app...", bot_id: "B123", ts: "230.000" },
        { type: "message", text: "<@B123> see the above chat", user: "U123", ts: "333.444" },
        {
          type: "message",
          text: "arrived after the trigger",
          user: "U456",
          ts: "333.444001",
        },
      ],
    });
    const env = makeSessionEnv(order);
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
      get: (key: string, type: string) => Promise<unknown>;
    };
    await kv.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> see the above chat",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(order).not.toContain("session");
    const repliesCalls = slackFetch.mock.calls.filter(
      ([input]) =>
        String(input).includes("conversations.replies") && String(input).includes("limit=200")
    );
    expect(repliesCalls).toHaveLength(1);
    expect(String(repliesCalls[0][0])).toContain("oldest=111.222");

    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    const content = String(promptBodies[0].content);
    expect(content).toContain("New messages in the Slack thread since your last task");
    expect(content).toContain("what do you think?");
    expect(content).toContain("i think we should do x");
    expect(content).toContain("Ajan\\n[Admin]");
    expect(content).not.toContain("Ajan\n[Admin]");
    // Bot replies and messages already forwarded stay out of the follow-up.
    expect(content).not.toContain("Working on acme/app");
    expect(content).not.toContain("do this action");
    expect(content).not.toContain("arrived after the trigger");
    expect(content).toContain("see the above chat");
    expect(content).toContain("[Ajan Admin (U123)]: see the above chat");
    // The triggering message itself is the prompt, not interim context.
    expect(content).not.toContain("<@B123>");
    await expect(kv.get("thread:C123:111.222", "json")).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1", lastPromptTs: "333.444" })
    );

    slackFetch.mockRestore();
  });

  it("forwards a prior image-only thread message with its causal context", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, {
      threadMessages: [
        { type: "message", text: "original request", user: "U123", ts: "111.222" },
        {
          type: "message",
          text: "older screenshots",
          user: "U456",
          ts: "200.000",
          files: Array.from({ length: 7 }, (_, i) => ({
            id: `F-old-${i}`,
            name: `older-${i}.png`,
            mimetype: "image/png",
            url_private: `https://files.slack.com/files-pri/T1-F-old-${i}/older.png`,
            size: 16,
          })),
        },
        {
          type: "message",
          text: "",
          user: "U456",
          ts: "222.000",
          attachments: [
            {
              is_share: true,
              author_name: "Ada",
              text: "forwarded screenshot context",
              files: [
                {
                  id: "F-prior",
                  name: "prior-screenshot.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/files-pri/T1-F-prior/prior.png",
                  size: 16,
                },
              ],
            },
          ],
        },
        {
          type: "message",
          text: "<@B123> inspect the screenshot above",
          user: "U123",
          ts: "333.444",
        },
      ],
    });
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> inspect the screenshot above",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const [prompt] = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(String(prompt!.content)).toContain('"ts":"222.000"');
    expect(String(prompt!.content)).toContain("forwarded screenshot context");
    expect(String(prompt!.content)).toContain("prior-screenshot.png");
    expect(String(prompt!.content)).not.toContain("https://files.slack.com");
    expect(prompt!.attachments).toEqual([
      { attachmentId: "att-1", name: "prior-screenshot.png" },
      ...Array.from({ length: 5 }, (_, i) => ({
        attachmentId: "att-1",
        name: `older-${i}.png`,
      })),
    ]);
    expect(order.indexOf("filedownload")).toBeLessThan(order.indexOf("attachment"));
    expect(order.indexOf("attachment")).toBeLessThan(order.indexOf("prompt"));

    slackFetch.mockRestore();
  });

  it("uploads event-carried images on follow-ups and references them in the prompt", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> what is wrong in this screenshot?",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
        files: [
          {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
            size: 16,
          },
        ],
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    // The event carried files, so the single-message lookup (inclusive-anchored;
    // the interim-history fetch at limit=200 is unrelated) runs only for the
    // attachments the event omitted, and the event's own files are used as-is.
    expect(
      slackFetch.mock.calls.filter(
        ([input]) =>
          String(input).includes("conversations.replies") &&
          String(input).includes("inclusive=true")
      )
    ).toHaveLength(1);
    expect(order).toContain("filedownload");
    expect(order).toContain("attachment");
    expect(order).not.toContain("session");
    expect(order.indexOf("attachment")).toBeLessThan(order.indexOf("prompt"));
    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0].attachments).toEqual([
      { attachmentId: "att-1", name: "screenshot.png" },
    ]);

    slackFetch.mockRestore();
  });

  it("recovers files for mentions whose event lacks them via conversation history", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, {
      threadMessages: [
        {
          type: "message",
          text: "<@B123> look at this",
          user: "U123",
          ts: "333.444",
          files: [
            {
              id: "F1",
              name: "bug.png",
              mimetype: "image/png",
              url_private: "https://files.slack.com/files-pri/T1-F1/bug.png",
              size: 16,
            },
          ],
        },
      ],
    });
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> look at this",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    // The single-message lookup recovered the file, which was then forwarded.
    // The lookup anchors on oldest=<target ts> with inclusive=true (replies are
    // oldest-first); the interim-history fetch never sets inclusive.
    const lookupCalls = slackFetch.mock.calls.filter(
      ([input]) =>
        String(input).includes("conversations.replies") &&
        String(input).includes("oldest=333.444") &&
        String(input).includes("inclusive=true")
    );
    expect(lookupCalls).toHaveLength(1);
    expect(order).toContain("filedownload");
    expect(order).toContain("attachment");
    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0].attachments).toEqual([{ attachmentId: "att-1", name: "bug.png" }]);

    slackFetch.mockRestore();
  });

  it("quotes a message forwarded with a mention into the prompt", async () => {
    // Forwarding puts the shared message's body in the message's `attachments`,
    // never in its `text` — which holds only the comment the user typed. The
    // mention event may omit attachments, so they come back with the same
    // single-message lookup that recovers files.
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, {
      threadMessages: [
        {
          type: "message",
          text: "<@B123> deal with this",
          user: "U123",
          ts: "333.444",
          attachments: [
            {
              is_msg_unfurl: true,
              is_share: true,
              author_name: "Ada Lovelace",
              channel_name: "engineering",
              channel_id: "C999",
              ts: "222.111",
              from_url: "https://acme.slack.com/archives/C999/p222111",
              text: "The nightly analytics job has failed three days running",
              files: [
                {
                  id: "F1",
                  name: "chart.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/files-pri/T1-F1/chart.png",
                  size: 16,
                },
              ],
            },
          ],
        },
      ],
    });
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> deal with this",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    const content = String(promptBodies[0].content);
    expect(content).toContain("Slack messages forwarded with this request");
    expect(content).toContain("[Forwarded message from Ada Lovelace in #engineering]");
    expect(content).toContain("The nightly analytics job has failed three days running");
    // Source ids let an agent with Slack tooling read the original thread.
    expect(content).toContain(
      "Source: https://acme.slack.com/archives/C999/p222111 — Slack channel C999 — message ts 222.111"
    );
    // The user's own instruction still lands last, after the quoted context.
    expect(content.endsWith("deal with this")).toBe(true);
    // The image the forwarded message carried rides the normal attachment path.
    expect(order).toContain("filedownload");
    expect(promptBodies[0].attachments).toEqual([{ attachmentId: "att-1", name: "chart.png" }]);

    slackFetch.mockRestore();
  });

  it("runs a forwarded message that arrived in a DM with no comment", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "thread:D123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "message",
        channel_type: "im",
        text: "",
        user: "U123",
        channel: "D123",
        ts: "333.444",
        thread_ts: "111.222",
        attachments: [
          {
            is_msg_unfurl: true,
            is_share: true,
            author_name: "Ada Lovelace",
            text: "The nightly analytics job has failed three days running",
          },
        ],
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    const content = String(promptBodies[0].content);
    expect(content).toContain(
      "[Forwarded message from Ada Lovelace]\nThe nightly analytics job has failed three days running"
    );
    // With no comment of their own the forward is the whole request, so the
    // prompt still ends with something actionable.
    expect(content.endsWith("See the forwarded Slack message(s).")).toBe(true);

    slackFetch.mockRestore();
  });

  it.each([
    [
      "a direct image-only DM loses every image",
      {
        subtype: "file_share",
        files: [
          {
            id: "F1",
            name: "screenshot.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/files-pri/T1-F1/screenshot.png",
            size: 16,
          },
        ],
      },
      true,
      2,
      "didn't start on this request",
    ],
    [
      "an image-only forwarded message loses every image",
      {
        text: "",
        attachments: [
          {
            is_msg_unfurl: true,
            is_share: true,
            author_name: "Ada Lovelace",
            channel_id: "C999",
            ts: "222.111",
            from_url: "https://acme.slack.com/archives/C999/p222111",
            text: "",
            files: [
              {
                id: "F1",
                name: "chart.png",
                mimetype: "image/png",
                url_private: "https://files.slack.com/files-pri/T1-F1/chart.png",
                size: 16,
              },
            ],
          },
        ],
      },
      true,
      2,
      "didn't start on this request",
    ],
    [
      "a body-less forward contains only unsupported files",
      {
        text: "",
        attachments: [
          {
            is_msg_unfurl: true,
            is_share: true,
            author_name: "Ada Lovelace",
            text: "",
            files: [
              {
                id: "F1",
                name: "incident.pdf",
                mimetype: "application/pdf",
                url_private: "https://files.slack.com/files-pri/T1-F1/incident.pdf",
                size: 16,
              },
            ],
          },
        ],
      },
      false,
      0,
      "Please include a message with your request",
    ],
    [
      "an app mention contains a body-less forward with only unsupported files",
      {
        type: "app_mention",
        text: "<@B123>",
        attachments: [
          {
            is_msg_unfurl: true,
            is_share: true,
            author_name: "Ada Lovelace",
            text: "",
            files: [
              {
                id: "F1",
                name: "incident.pdf",
                mimetype: "application/pdf",
                url_private: "https://files.slack.com/files-pri/T1-F1/incident.pdf",
                size: 16,
              },
            ],
          },
        ],
      },
      false,
      0,
      "Please include a message with your request",
    ],
  ] satisfies Array<[string, Record<string, unknown>, boolean, number, string]>)(
    "starts nothing when %s",
    async (_caseName, eventFields, downloadsImage, expectedStartingStatuses, expectedMessage) => {
      const order: string[] = [];
      const slackFetch = mockSlackFetch(order, { fileDownloadStatus: 403 });
      const env = makeSessionEnv(order);
      const ctx = makeCtx();

      const response = await app.fetch(
        slackEventRequest({
          type: "message",
          user: "U123",
          channel: "D123",
          ts: "444.555",
          channel_type: "im",
          ...eventFields,
        }),
        env,
        ctx
      );

      expect(response.status).toBe(200);
      await flushWaitUntil(ctx);

      // The placeholder prompt would be meaningless with no image attached, so
      // no session is created and the user is told nothing ran.
      if (downloadsImage) expect(order).toContain("filedownload");
      else expect(order).not.toContain("filedownload");
      expect(startingStatusBodies(slackFetch)).toHaveLength(expectedStartingStatuses);
      expect(order).not.toContain("session");
      expect(order).not.toContain("prompt");
      expect(slackApiBodies(slackFetch, "chat.postMessage")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining(expectedMessage),
          }),
        ])
      );

      slackFetch.mockRestore();
    }
  );

  it("keeps the interim checkpoint when the thread fetch fails", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { threadRepliesError: "ratelimited" });
    const env = makeSessionEnv(order);
    const kv = env.SLACK_KV as unknown as {
      put: (key: string, value: string) => Promise<void>;
      get: (key: string, type: string) => Promise<unknown>;
    };
    await kv.put(
      "thread:C123:111.222",
      JSON.stringify({
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        createdAt: Date.now(),
        lastPromptTs: "111.222",
      })
    );
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123> see the above chat",
        user: "U123",
        channel: "C123",
        ts: "333.444",
        thread_ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    // The prompt is still sent — thread context stays best effort — but the
    // checkpoint is not advanced past messages that were never considered.
    const promptBodies = promptFetchBodies(env.CONTROL_PLANE.fetch);
    expect(promptBodies).toHaveLength(1);
    expect(String(promptBodies[0].content)).not.toContain(
      "New messages in the Slack thread since your last task"
    );
    await expect(kv.get("thread:C123:111.222", "json")).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1", lastPromptTs: "111.222" })
    );

    slackFetch.mockRestore();
  });

  it("does not set Starting status for empty app mentions", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "app_mention",
        text: "<@B123>    ",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(statusFetchBodies(slackFetch)).toEqual([]);
    expect(order).not.toContain("status");

    slackFetch.mockRestore();
  });
});

describe("POST /interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    clearEnvironmentsLocalCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockOpenView.mockResolvedValue({ ok: true });
    mockGetUserInfo.mockResolvedValue({ ok: false, error: "user_not_found" });
  });

  it("sets Starting status for repo-selection starts before session creation", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: "acme/app" },
        },
      ],
    };
    const request = slackInteractionRequest(payload);
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);
    await flushWaitUntil(ctx, 1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(3);

    expect(statusFetchBodies(slackFetch)).toContainEqual({
      channel_id: "C123",
      thread_ts: "111.222",
      status: "Starting...",
      loading_messages: ["Starting..."],
    });
    expect(startingStatusBodies(slackFetch)).toHaveLength(2);
    expect(order.indexOf("repos")).toBeLessThan(order.indexOf("status"));
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("session"));

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    expect(postBodies.some((body) => String(body.text).includes("Session started!"))).toBe(false);

    const updateBodies = slackApiBodies(slackFetch, "chat.update");
    expect(updateBodies).toEqual([
      // The clarification message collapses to text with no blocks, which is
      // what makes Slack drop its picker.
      { channel: "C123", ts: "111.222", text: "Using *acme/app*" },
      expect.objectContaining({
        channel: "C123",
        ts: "222.333",
        text: "Starting work...",
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "actions",
            elements: expect.arrayContaining([
              expect.objectContaining({
                type: "button",
                text: { type: "plain_text", text: "View Session" },
                url: "https://app.test/session/session-1",
                action_id: "view_session",
              }),
            ]),
          }),
        ]),
      }),
    ]);

    slackFetch.mockRestore();
  });

  it("does not set Starting status when selected repo is no longer available", async () => {
    const slackFetch = mockSlackFetch([]);
    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );

    env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/channel-bindings/slack/")) return Response.json({ teamId: null });
      if (url.includes("/repos")) {
        return new Response(JSON.stringify(mockReposResponseBody([])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ enabledModels: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: "acme/app" },
        },
      ],
    };
    const request = slackInteractionRequest(payload);
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(statusFetchBodies(slackFetch)).toEqual([]);

    slackFetch.mockRestore();
  });

  it.each(["foo..bar", "release/", "-bad", "@", "foo/.bar", "foo.lock"])(
    "rejects invalid branch submission %s",
    async (branch) => {
      const payload = {
        type: "view_submission",
        user: { id: "U123" },
        view: {
          callback_id: "branch_preference_modal",
          state: {
            values: {
              branch_input: {
                branch_value: {
                  type: "plain_text_input",
                  value: branch,
                },
              },
            },
          },
        },
      };

      const request = slackInteractionRequest(payload);

      const env = makeEnv();
      const ctx = makeCtx();
      const response = await app.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        response_action: "errors",
        errors: {
          branch_input: "Enter a valid Git branch name.",
        },
      });
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(
        (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put
      ).not.toHaveBeenCalled();
      expect(mockPublishView).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid repo branch submission", async () => {
    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/app" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "feature..bad",
              },
            },
          },
        },
      },
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_action: "errors",
      errors: {
        branch_input: "Enter a valid Git branch name.",
      },
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("acknowledges branch preference submissions before App Home publish completes", async () => {
    const publishDeferred = createDeferred<{ ok: boolean }>();
    mockPublishView.mockReturnValue(publishDeferred.promise);

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "branch_preference_modal",
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "main",
              },
            },
          },
        },
      },
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const ctx = makeCtx();
    const responsePromise = Promise.resolve(app.fetch(request, env, ctx));

    const outcome = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(outcome).toBe("response");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    const backgroundPromise = ctx.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    const backgroundOutcome = await Promise.race([
      backgroundPromise.then(() => "background-complete"),
      new Promise<string>((resolve) => setTimeout(() => resolve("background-pending"), 25)),
    ]);

    expect(backgroundOutcome).toBe("background-pending");

    publishDeferred.resolve({ ok: true });
    await flushWaitUntil(ctx);
    expect(mockPublishView).toHaveBeenCalledOnce();
  });

  it("persists global branch preference to KV", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "branch_preference_modal",
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "staging",
              },
            },
          },
        },
      },
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    const prefsCall = kvPut.mock.calls.find((args: unknown[]) => args[0] === "user_prefs:U123");
    expect(prefsCall).toBeTruthy();
    const saved = JSON.parse(prefsCall![1] as string) as { branch?: string };
    expect(saved.branch).toBe("staging");
  });

  it("stores repo-specific branch preference from repo branch modal", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/app" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "release/2026-03",
              },
            },
          },
        },
      },
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    expect(kvPut).toHaveBeenCalledWith("user_repo_branch:U123:acme/app", "release/2026-03");

    const publishCall = mockPublishView.mock.calls.at(-1);
    expect(publishCall?.[1]).toBe("U123");
    expect(JSON.stringify(publishCall?.[2])).toContain("acme/app");
    expect(JSON.stringify(publishCall?.[2])).toContain("release/2026-03");
  });

  it("ignores repo-specific branch submission for unknown repo", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/unknown" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "release/2026-03",
              },
            },
          },
        },
      },
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    expect(kvPut).not.toHaveBeenCalledWith("user_repo_branch:U123:acme/unknown", "release/2026-03");
  });

  it("forwards display identity and prefers repo branch over global branch on session creation", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "123.456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    mockGetUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: "U123",
        name: "jdoe",
        real_name: "Jane Doe",
        profile: {
          display_name: "Jane",
          email: "jane@example.com",
        },
      },
    });

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: "acme/app" },
        },
      ],
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );
    await env.SLACK_KV.put(
      "user_prefs:U123",
      JSON.stringify({
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "medium",
        branch: "global-branch",
        updatedAt: Date.now(),
      })
    );
    await env.SLACK_KV.put("user_repo_branch:U123:acme/app", "repo-branch");

    env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/channel-bindings/slack/")) return Response.json({ teamId: null });
      if (url.includes("/repos")) {
        return new Response(
          JSON.stringify(
            mockReposResponseBody([
              {
                id: "acme/app",
                owner: "acme",
                name: "app",
                fullName: "acme/app",
                defaultBranch: "main",
                private: true,
              },
            ])
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/sessions")) {
        return new Response(JSON.stringify({ sessionId: "session-1", status: "created" }), {
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
      return new Response(JSON.stringify({ enabledModels: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const sessionCall = env.CONTROL_PLANE.fetch.mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.actorDisplayName).toBe("Jane");
    expect(body.actorEmail).toBe("jane@example.com");
    expect(body.branch).toBe("repo-branch");
    expect(mockGetUserInfo).toHaveBeenCalledOnce();
    // Identity travels via the signed actor assertion, never the body.
    expect(body.actorUserId).toBeUndefined();
    expect(body.spawnSource).toBeUndefined();

    slackFetch.mockRestore();
  });

  it("creates session even when getUserInfo throws", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "123.456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    mockGetUserInfo.mockRejectedValue(new Error("Slack API down"));

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: "acme/app" },
        },
      ],
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );

    env.CONTROL_PLANE.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/channel-bindings/slack/")) return Response.json({ teamId: null });
      if (url.includes("/repos")) {
        return new Response(
          JSON.stringify(
            mockReposResponseBody([
              {
                id: "acme/app",
                owner: "acme",
                name: "app",
                fullName: "acme/app",
                defaultBranch: "main",
                private: true,
              },
            ])
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/sessions")) {
        return new Response(JSON.stringify({ sessionId: "session-1", status: "created" }), {
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
      return new Response(JSON.stringify({ enabledModels: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const sessionCall = env.CONTROL_PLANE.fetch.mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.actorDisplayName).toBeUndefined();
    expect(body.actorEmail).toBeUndefined();
    // Identity travels via the signed actor assertion, never the body.
    expect(body.actorUserId).toBeUndefined();
    expect(body.spawnSource).toBeUndefined();

    slackFetch.mockRestore();
  });

  it("clears repo-specific branch override from App Home", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      actions: [
        {
          action_id: "clear_repo_branch_override",
          value: "acme/app",
        },
      ],
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_repo_branch:U123:acme/app",
      "staging"
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvDelete = (env.SLACK_KV as unknown as { delete: ReturnType<typeof vi.fn> }).delete;
    expect(kvDelete).toHaveBeenCalledWith("user_repo_branch:U123:acme/app");
    expect(mockPublishView).toHaveBeenCalled();
  });

  it("returns repo suggestions beyond 100 repos via search", async () => {
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo_branch_override",
      user: { id: "U123" },
      value: "repo-150",
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const repos = buildNumberedRepos(150);
    mockReposFetch(env, repos);

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    const body = (await response.json()) as {
      options: Array<{ text: { type: string; text: string }; value: string }>;
    };
    expect(body.options).toEqual([
      {
        text: { type: "plain_text", text: "acme/repo-150" },
        value: "acme/repo-150",
      },
    ]);
  });

  it("routes a quick-pick button click through repo selection", async () => {
    const slackFetch = mockSlackFetch([]);
    const env = makeEnv();
    // No pending message stored, so repo selection reports it can't find the request —
    // which proves the quick-pick button routed into the same handler as the picker.

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo_quick_pick",
          block_id: "target_quick_picks:00000000-0000-4000-8000-000000000001",
          value: "acme/app",
        },
      ],
    };
    const request = slackInteractionRequest(payload);
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);

    await flushWaitUntil(ctx);

    const postBodies = slackApiBodies(slackFetch, "chat.postEphemeral");
    expect(
      postBodies.some((body) => String(body.text).includes("target selection has expired"))
    ).toBe(true);

    slackFetch.mockRestore();
  });

  it("returns all repos (beyond the old 5-item limit) for the repo clarification picker", async () => {
    const slackFetch = mockSlackFetch();
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo",
      block_id: "target_picker:00000000-0000-4000-8000-000000000001",
      user: { id: "U123" },
      channel: { id: "C123" },
      value: "",
    };

    const request = slackInteractionRequest(payload);
    request.headers.delete("x-slack-signature");
    request.headers.delete("x-slack-request-timestamp");

    const env = makeEnv();
    const repos = buildNumberedRepos(150);
    mockReposFetch(env, repos);
    await env.SLACK_KV.put(
      "pending:00000000-0000-4000-8000-000000000001",
      JSON.stringify({
        requestId: "00000000-0000-4000-8000-000000000001",
        channel: "C123",
        threadTs: "111.222",
        message: "Fix it",
        userId: "U123",
        teamId: null,
      })
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(mockVerifySlackSignature).toHaveBeenCalledWith(
      null,
      null,
      new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
      env.SLACK_SIGNING_SECRET
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    const body = (await response.json()) as {
      options: Array<{ text: { type: string; text: string }; value: string }>;
    };
    // Old behavior capped this at 5; new behavior shows the full list up to
    // Slack's per-response ceiling.
    expect(body.options).toHaveLength(100);
    expect(body.options[0]).toEqual({
      text: { type: "plain_text", text: "No repository" },
      description: { type: "plain_text", text: "Start without cloning a repository" },
      value: "__no_repository__",
    });
    expect(slackFetch).not.toHaveBeenCalled();
    slackFetch.mockRestore();
  });

  it.each([null, "team-a"])("filters channel clarification suggestions (%s)", async (teamId) => {
    const slackFetch = mockSlackFetch();
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo",
      block_id: "target_picker:00000000-0000-4000-8000-000000000001",
      user: { id: "U123" },
      channel: { id: "C123" },
      value: "repo-150",
    };

    const request = slackInteractionRequest(payload);

    const env = makeEnv();
    const repos = buildNumberedRepos(150);
    mockReposFetch(env, repos, teamId);
    await env.SLACK_KV.put(
      "pending:00000000-0000-4000-8000-000000000001",
      JSON.stringify({
        requestId: "00000000-0000-4000-8000-000000000001",
        channel: "C123",
        threadTs: "111.222",
        message: "Fix it",
        userId: "U123",
        teamId,
      })
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      options: Array<{ text: { type: string; text: string }; value: string }>;
    };
    expect(body.options).toEqual([
      {
        text: { type: "plain_text", text: "No repository" },
        description: { type: "plain_text", text: "Start without cloning a repository" },
        value: "__no_repository__",
      },
      {
        text: { type: "plain_text", text: "repo-150" },
        description: { type: "plain_text", text: "repo-150" },
        value: "acme/repo-150",
      },
    ]);
    expect(env.SLACK_KV.get).toHaveBeenCalledWith(
      "pending:00000000-0000-4000-8000-000000000001",
      "json"
    );
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/channel-bindings/slack/C123",
      expect.anything()
    );
    for (const resource of ["repos", "environments"]) {
      const catalogReads = env.CONTROL_PLANE.fetch.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === `/${resource}`
      );
      expect(catalogReads).toHaveLength(1);
      for (const [url, init] of catalogReads) {
        expect(String(url)).toBe(`https://internal/${resource}?channel=slack%3AC123`);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-OpenInspect-Actor")).toBe("slack:U123");
        expect(headers.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
      }
    }
    expect(slackFetch).not.toHaveBeenCalled();
    slackFetch.mockRestore();
  });

  it.each<{ binding?: unknown; pending?: unknown; payload?: Record<string, unknown> }>([
    { binding: { teamId: "team-b", kind: "primary" } },
    { binding: { teamId: null } },
    { binding: 404 },
    { binding: 503 },
    { binding: { invalid: true } },
    { binding: new Error("CP offline") },
    { pending: null },
    { pending: new Error("KV unavailable") },
    { pending: { teamId: undefined } },
    { payload: { block_id: undefined } },
    { payload: { block_id: "malformed" } },
    { payload: { user: { id: "other" } } },
    { payload: { user: undefined } },
    { payload: { channel: { id: "other" } } },
    { payload: { channel: undefined } },
  ])("withholds suggestions and visible instructions for untrusted scope: %j", async (failure) => {
    const slackFetch = mockSlackFetch();
    const env = makeEnv();
    const requestId = "00000000-0000-4000-8000-000000000001";
    const pending = {
      requestId,
      channel: "C123",
      threadTs: "111.222",
      userId: "U123",
      message: "Fix it",
      teamId: "team-a",
    };
    const kv = env.SLACK_KV as unknown as ReturnType<typeof createMockKV>;
    kv.get.mockImplementation(async () => {
      if (failure.pending instanceof Error) throw failure.pending;
      return failure.pending === null ? null : { ...pending, ...(failure.pending as object) };
    });
    env.CONTROL_PLANE.fetch.mockImplementation(async () => {
      if (failure.binding instanceof Error) throw failure.binding;
      return typeof failure.binding === "number"
        ? new Response(null, { status: failure.binding })
        : Response.json(failure.binding ?? { teamId: "team-a", kind: "primary" });
    });
    const ctx = makeCtx();
    const response = await app.fetch(
      slackInteractionRequest({
        type: "block_suggestion",
        action_id: "select_repo",
        value: "app",
        user: { id: "U123" },
        channel: { id: "C123" },
        block_id: `target_picker:${requestId}`,
        ...failure.payload,
      }),
      env,
      ctx
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ options: [] });
    expect(env.CONTROL_PLANE.fetch.mock.calls.map(([url]) => String(url))).toEqual(
      "binding" in failure ? ["https://internal/channel-bindings/slack/C123"] : []
    );
    expect(slackFetch).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    slackFetch.mockRestore();
  });
});
