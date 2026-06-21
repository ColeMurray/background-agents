import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import type * as SharedModule from "@open-inspect/shared";

const { mockVerifySlackSignature, mockPublishView, mockOpenView, mockGetUserInfo } = vi.hoisted(
  () => ({
    mockVerifySlackSignature: vi.fn(),
    mockPublishView: vi.fn(),
    mockOpenView: vi.fn(),
    mockGetUserInfo: vi.fn(),
  })
);

vi.mock("@open-inspect/shared", async () => {
  const actual = await vi.importActual<typeof SharedModule>("@open-inspect/shared");
  return {
    ...actual,
    verifySlackSignature: mockVerifySlackSignature,
    publishView: mockPublishView,
    openView: mockOpenView,
    getUserInfo: mockGetUserInfo,
  };
});

import app from "./index";
import { clearLocalCache } from "./classifier/repos";
import { resetSlackSettingsCache } from "./integration-settings";

/**
 * Build the control-plane response for GET /integration-settings/slack.
 * `undefined` → no stored settings (default: private contexts allowed).
 */
function slackSettingsResponse(allowPrivateChannels?: boolean): Response {
  return new Response(
    JSON.stringify({
      integrationId: "slack",
      settings: allowPrivateChannels === undefined ? null : { defaults: { allowPrivateChannels } },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

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

function makeEnv(opts: { allowPrivateChannels?: boolean } = {}): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    CONTROL_PLANE: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/integration-settings/slack")) {
          return slackSettingsResponse(opts.allowPrivateChannels);
        }
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
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
      }),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
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

/** Point CONTROL_PLANE.fetch at a fixed repo list (other routes return enabledModels). */
function mockReposFetch(env: Env, repos: unknown[]) {
  (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/repos")) {
        return new Response(JSON.stringify({ repos }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  );
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

function makeSessionEnv(order: string[] = [], opts: { allowPrivateChannels?: boolean } = {}): Env {
  const env = makeEnv(opts);
  (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/integration-settings/slack")) {
        return slackSettingsResponse(opts.allowPrivateChannels);
      }
      if (url.includes("/repos")) {
        order.push("repos");
        return new Response(
          JSON.stringify({
            repos: [
              {
                id: "acme/app",
                owner: "acme",
                name: "app",
                fullName: "acme/app",
                defaultBranch: "main",
                private: true,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (url.endsWith("/sessions")) {
        order.push("session");
        return new Response(JSON.stringify({ sessionId: "session-1", status: "running" }), {
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
    }
  );
  return env;
}

function mockSlackFetch(
  order: string[] = [],
  options: {
    statusResponse?: Response | Promise<Response>;
    threadMessages?: unknown[];
    channelIsPrivate?: boolean;
    channelInfoResponse?: Response;
  } = {}
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("assistant.threads.setStatus")) {
      order.push("status");
      return (
        options.statusResponse ??
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    if (url.includes("conversations.info")) {
      order.push("channelInfo");
      if (options.channelInfoResponse) {
        return options.channelInfoResponse;
      }
      return new Response(
        JSON.stringify({
          ok: true,
          channel: {
            id: "C123",
            name: "eng",
            topic: { value: "" },
            purpose: { value: "" },
            is_private: options.channelIsPrivate ?? false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("conversations.replies")) {
      return new Response(JSON.stringify({ ok: true, messages: options.threadMessages ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

describe("POST /events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    resetSlackSettingsCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockGetUserInfo.mockResolvedValue({ ok: true, user: undefined });
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

  it("sets Starting status for a new app mention before session creation", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order);
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
    // Channel info is fetched first (it feeds the private-context gate), then the
    // Starting status is scheduled — still well before the slow session creation.
    // Guard against vacuous pass: a missing "channelInfo" would make indexOf return -1.
    expect(order).toContain("channelInfo");
    expect(order.indexOf("channelInfo")).toBeLessThan(order.indexOf("status"));
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("session"));

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    expect(postBodies.some((body) => String(body.text).includes("Session started!"))).toBe(false);

    const sessionBodies = sessionFetchBodies(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(sessionBodies[0]).not.toHaveProperty("title");

    const updateBodies = slackApiBodies(slackFetch, "chat.update");
    expect(updateBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "C123",
          ts: "222.333",
          text: "Working on *acme/app*...",
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

    const promptBodies = promptFetchBodies(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0].content).toContain("now add coverage");
    expect(promptBodies[0].content).toContain("Slack channel context");
    expect(promptBodies[0].content).not.toContain("Context from the Slack thread");
    expect(promptBodies[0].content).not.toContain("The latest commit is");

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

  it("does not wait for Starting status before creating a session", async () => {
    const statusDeferred = createDeferred<Response>();
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { statusResponse: statusDeferred.promise });
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
    const backgroundPromise = ctx.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    const backgroundOutcome = await Promise.race([
      backgroundPromise.then(() => "complete"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ]);

    expect(backgroundOutcome).toBe("complete");
    expect(order).toContain("session");
    expect(order).toContain("prompt");
    expect(ctx.waitUntil).toHaveBeenCalledTimes(4);

    const statusPromise = ctx.waitUntil.mock.calls[1]?.[0] as Promise<void>;
    const statusOutcome = await Promise.race([
      statusPromise.then(() => "complete"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(statusOutcome).toBe("pending");

    statusDeferred.resolve(
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    slackFetch.mockRestore();
  });
});

describe("POST /interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    resetSlackSettingsCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockOpenView.mockResolvedValue({ ok: true });
    mockGetUserInfo.mockResolvedValue({ ok: true, user: undefined });
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
    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);

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
    expect(order.indexOf("repos")).toBeLessThan(order.indexOf("status"));
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("session"));

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    expect(postBodies.some((body) => String(body.text).includes("Session started!"))).toBe(false);

    const updateBodies = slackApiBodies(slackFetch, "chat.update");
    expect(updateBodies).toEqual([
      expect.objectContaining({
        channel: "C123",
        ts: "222.333",
        text: "Working on *acme/app*...",
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

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(JSON.stringify({ repos: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ enabledModels: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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
    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
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

      const request = new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=test",
          "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: new URLSearchParams({ payload: JSON.stringify(payload) }),
      });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

  it("prefers repo branch over global branch when creating a session", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_preferences:U123",
      JSON.stringify({
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "medium",
        branch: "global-branch",
        updatedAt: Date.now(),
      })
    );
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_repo_branch:U123:acme/app",
      "repo-branch"
    );

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-1", status: "running" }), {
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

        return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);
    await flushWaitUntil(ctx, 1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(4);

    const sessionCall = (
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { branch?: string };
    expect(body.branch).toBe("repo-branch");

    slackFetch.mockRestore();
  });

  it("forwards identity fields from getUserInfo to session creation", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-1", status: "running" }), {
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
      }
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const sessionCall = (
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.actorUserId).toBe("U123");
    expect(body.actorDisplayName).toBe("Jane");
    expect(body.actorEmail).toBe("jane@example.com");
    expect(body.spawnSource).toBe("slack-bot");

    slackFetch.mockRestore();
  });

  it("creates session even when getUserInfo throws", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-1", status: "running" }), {
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
      }
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const sessionCall = (
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.actorUserId).toBe("U123");
    expect(body.actorDisplayName).toBeUndefined();
    expect(body.actorEmail).toBeUndefined();
    expect(body.spawnSource).toBe("slack-bot");

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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
          value: "acme/app",
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
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);

    await flushWaitUntil(ctx);

    const postBodies = slackApiBodies(slackFetch, "chat.postMessage");
    expect(
      postBodies.some((body) => String(body.text).includes("couldn't find your original request"))
    ).toBe(true);

    slackFetch.mockRestore();
  });

  it("returns all repos (beyond the old 5-item limit) for the repo clarification picker", async () => {
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo",
      user: { id: "U123" },
      value: "",
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

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
    // Old behavior capped this at 5; new behavior shows the full list up to
    // Slack's per-response ceiling.
    expect(body.options).toHaveLength(100);
    expect(body.options[0]).toEqual({
      text: { type: "plain_text", text: "repo-001" },
      description: { type: "plain_text", text: "repo-001" },
      value: "acme/repo-001",
    });
  });

  it("filters repo clarification suggestions by the typed query", async () => {
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo",
      user: { id: "U123" },
      value: "repo-150",
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const repos = buildNumberedRepos(150);
    mockReposFetch(env, repos);

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      options: Array<{ text: { type: string; text: string }; value: string }>;
    };
    expect(body.options).toEqual([
      {
        text: { type: "plain_text", text: "repo-150" },
        description: { type: "plain_text", text: "repo-150" },
        value: "acme/repo-150",
      },
    ]);
  });
});

describe("private-context gate (allowPrivateChannels)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    resetSlackSettingsCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockGetUserInfo.mockResolvedValue({ ok: true, user: undefined });
  });

  function refusalPosted(slackFetch: ReturnType<typeof mockSlackFetch>): boolean {
    return slackApiBodies(slackFetch, "chat.postMessage").some((body) =>
      String(body.text).includes("public channels")
    );
  }

  it("toggle OFF: declines an app mention in a private channel (no session, no status)", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { channelIsPrivate: true });
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
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
    await flushWaitUntil(ctx, 1);

    expect(refusalPosted(slackFetch)).toBe(true);
    expect(order).not.toContain("session");
    expect(order).not.toContain("prompt");
    expect(startingStatusBodies(slackFetch)).toHaveLength(0);

    slackFetch.mockRestore();
  });

  it("toggle OFF: allows an app mention in a public channel", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { channelIsPrivate: false });
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
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
    await flushWaitUntil(ctx, 1);

    expect(refusalPosted(slackFetch)).toBe(false);
    expect(order).toContain("session");
    expect(order).toContain("prompt");

    slackFetch.mockRestore();
  });

  it("toggle OFF: declines a direct message (im) without a conversations.info call", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
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

    expect(refusalPosted(slackFetch)).toBe(true);
    expect(order).not.toContain("session");
    expect(order).not.toContain("channelInfo");
    expect(startingStatusBodies(slackFetch)).toHaveLength(0);

    slackFetch.mockRestore();
  });

  it("toggle OFF: declines a group DM (mpim)", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order);
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
    const ctx = makeCtx();

    const response = await app.fetch(
      slackEventRequest({
        type: "message",
        text: "fix the auth tests",
        user: "U123",
        channel: "G123",
        ts: "444.555",
        channel_type: "mpim",
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(refusalPosted(slackFetch)).toBe(true);
    expect(order).not.toContain("session");

    slackFetch.mockRestore();
  });

  it("toggle OFF: fail-closed when conversations.info fails", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, {
      channelInfoResponse: new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
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
    await flushWaitUntil(ctx, 1);

    expect(refusalPosted(slackFetch)).toBe(true);
    expect(order).not.toContain("session");

    slackFetch.mockRestore();
  });

  it("toggle ON: allows a private channel (regression — default behavior unchanged)", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { channelIsPrivate: true });
    const env = makeSessionEnv(order, { allowPrivateChannels: true });
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
    await flushWaitUntil(ctx, 1);

    expect(refusalPosted(slackFetch)).toBe(false);
    expect(order).toContain("session");

    slackFetch.mockRestore();
  });

  it("toggle OFF: declines a repo-selection interaction in a private channel (back-door C1)", async () => {
    const order: string[] = [];
    const slackFetch = mockSlackFetch(order, { channelIsPrivate: true });
    const env = makeSessionEnv(order, { allowPrivateChannels: false });
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({ message: "Please handle this", userId: "U123" })
    );

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [{ action_id: "select_repo", selected_option: { value: "acme/app" } }],
    };
    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    const ctx = makeCtx();

    const response = await app.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);
    await flushWaitUntil(ctx, 1);

    expect(refusalPosted(slackFetch)).toBe(true);
    expect(order).not.toContain("session");
    expect(order).not.toContain("prompt");

    slackFetch.mockRestore();
  });
});
