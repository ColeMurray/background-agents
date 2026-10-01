import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { callbacksRouter } from "./callbacks";
import { makeExecutionContext as makeCtx } from "./test-helpers";
import type { Env } from "./types";
import {
  isThreadSessionClosed,
  lookupThreadSession,
  storeThreadSession,
} from "./sessions/thread-session-store";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace,
    SLACK_COMPLETION_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    SERVICE_AUTH_SECRET: "callback-secret",
    LOG_LEVEL: "error",
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/callbacks", callbacksRouter);
  return app;
}

async function signPayload<T extends Record<string, unknown>>(
  data: T,
  secret = "callback-secret"
): Promise<T & { signature: string }> {
  return {
    ...data,
    signature: await computeHmacHex(JSON.stringify(data), secret),
  };
}

async function makeToolCallPayload(
  overrides: Partial<{
    sessionId: string;
    tool: string;
    args: Record<string, unknown>;
    callId: string;
    timestamp: number;
    context: Record<string, unknown>;
  }> = {},
  secret = "callback-secret"
) {
  const data = {
    sessionId: "session-1",
    tool: "read",
    args: { filePath: "src/auth.ts" },
    callId: "call-1",
    timestamp: 1778900000000,
    context: {
      source: "slack",
      channel: "C123",
      threadTs: "111.222",
      repoFullName: "acme/app",
      model: "anthropic/claude-haiku-4-5",
    },
    ...overrides,
  };

  return signPayload(data, secret);
}

async function postToolCall(payload: unknown, env = makeEnv(), ctx = makeCtx()) {
  const response = await makeApp().fetch(
    new Request("http://localhost/callbacks/tool_call", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-trace-id": "trace-1" },
      body: JSON.stringify(payload),
    }),
    env,
    ctx
  );
  return { response, env, ctx };
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe("POST /callbacks/tool_call", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid payloads", async () => {
    const { response, ctx } = await postToolCall({ sessionId: "session-1" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects signed tool calls with partial Slack context", async () => {
    const payload = await makeToolCallPayload({
      context: {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
      },
    });
    const { response, ctx } = await postToolCall(payload);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON payloads", async () => {
    const ctx = makeCtx();
    const response = await makeApp().fetch(
      new Request("http://localhost/callbacks/tool_call", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-trace-id": "trace-1" },
        body: "{",
      }),
      makeEnv(),
      ctx
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns 500 when callback signing is not configured", async () => {
    const payload = await makeToolCallPayload();
    const { response, ctx } = await postToolCall(payload, makeEnv({ SERVICE_AUTH_SECRET: "" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "not configured" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects bad signatures", async () => {
    const payload = await makeToolCallPayload({}, "wrong-secret");
    const { response, ctx } = await postToolCall(payload);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("accepts callbacks signed with the bot's per-service secret", async () => {
    const payload = await makeToolCallPayload({}, "slack-service-secret");
    const { response } = await postToolCall(
      payload,
      makeEnv({ SERVICE_AUTH_SECRET: "slack-service-secret" })
    );
    expect(response.status).not.toBe(401);
  });

  it("rejects callbacks signed with the retired shared secret", async () => {
    const payload = await makeToolCallPayload();
    const { response, ctx } = await postToolCall(
      payload,
      makeEnv({ SERVICE_AUTH_SECRET: "slack-service-secret" })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("accepts signed tool calls and updates the Slack assistant thread status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const payload = await makeToolCallPayload();
    const { response, ctx } = await postToolCall(payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/assistant.threads.setStatus", {
      method: "POST",
      headers: {
        Authorization: "Bearer xoxb-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: "C123",
        thread_ts: "111.222",
        status: "Working...",
        loading_messages: ["Reading src/auth.ts"],
      }),
    });
  });

  it("rejects signed payloads with malformed Slack context", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const payload = await makeToolCallPayload({
      context: {
        source: "linear",
        channel: "C123",
        threadTs: "111.222",
      },
    });
    const { response, ctx } = await postToolCall(payload);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps Slack API failures isolated from the accepted route response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const payload = await makeToolCallPayload();
    const { response, ctx } = await postToolCall(payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(flushWaitUntil(ctx)).resolves.toBeUndefined();
  });

  it("responds before Slack status delivery finishes", async () => {
    const deferred = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(deferred.promise);
    const payload = await makeToolCallPayload();
    const ctx = makeCtx();

    const response = await makeApp().fetch(
      new Request("http://localhost/callbacks/tool_call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      makeEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    deferred.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await flushWaitUntil(ctx);
  });
});

function okFetchMock() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, channel: "C123", ts: "111.333" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function slackCall(
  fetchMock: ReturnType<typeof okFetchMock>,
  endpoint: string
): { url: string; body: Record<string, unknown> } | undefined {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes(endpoint));
  if (!call) return undefined;
  return {
    url: String(call[0]),
    body: JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  };
}

async function postCallback(path: string, payload: unknown, env = makeEnv(), ctx = makeCtx()) {
  const response = await makeApp().fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-trace-id": "trace-1" },
      body: JSON.stringify(payload),
    }),
    env,
    ctx
  );
  return { response, env, ctx };
}

describe("POST /callbacks/activity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function activityData(overrides: Record<string, unknown> = {}) {
    return {
      kind: "slack.activity_refresh",
      sessionId: "session-1",
      messageId: "msg-1",
      timestamp: Date.now(),
      context: {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
      },
      ...overrides,
    };
  }

  it("re-asserts the working indicator on the thread", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(activityData());

    const { response, ctx } = await postCallback("/callbacks/activity", payload);
    expect(response.status).toBe(200);

    await flushWaitUntil(ctx);
    expect(slackCall(fetchMock, "assistant.threads.setStatus")?.body).toEqual({
      channel_id: "C123",
      thread_ts: "111.222",
      status: "Working...",
      loading_messages: ["Working..."],
    });
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(activityData(), "wrong-secret");

    const { response, ctx } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a stale refresh", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(activityData({ timestamp: Date.now() - 5 * 60 * 1000 }));

    const { response, ctx } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a future-dated refresh", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(activityData({ timestamp: Date.now() + 5 * 60 * 1000 }));

    const { response, ctx } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a validly signed completion payload replayed onto this route", async () => {
    const fetchMock = okFetchMock();
    // A real /callbacks/complete body: same signing key, same context, and its
    // signature verifies. Only the domain separator keeps it off this route.
    const payload = await signPayload({
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      context: {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
      },
    });

    const { response } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a refresh carrying the wrong domain separator", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(activityData({ kind: "slack.completion" }));

    const { response } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a payload missing the thread context", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload({
      sessionId: "session-1",
      messageId: "msg-1",
      timestamp: Date.now(),
    });

    const { response } = await postCallback("/callbacks/activity", payload);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /callbacks/thread_closed", () => {
  afterEach(() => vi.restoreAllMocks());
  const closureKey = "thread-closed:C123:111.222:session-1";
  const noticeKey = `${closureKey}:notice`;

  function closedData(overrides: Record<string, unknown> = {}) {
    return {
      kind: "slack.thread_closed",
      sessionId: "session-1",
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "111.222" },
      ...overrides,
    };
  }

  async function mappedEnv(withMapping = true) {
    const values = new Map<string, string>();
    const env = makeEnv({
      SLACK_KV: {
        get: vi.fn(async (key: string, type?: string) => {
          const value = values.get(key);
          return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
        }),
        put: vi.fn(async (key: string, value: string) => {
          values.set(key, value);
        }),
      } as unknown as KVNamespace,
    });
    if (withMapping)
      await storeThreadSession(env, "C123", "111.222", {
        sessionId: "session-1",
        repoId: "acme/app",
        repoFullName: "acme/app",
        model: "openai/gpt-5.4",
        createdAt: 1,
        teamId: "team-a",
      });
    return env;
  }

  it("persists closure first but waits for Slack before accepting and marking the notice sent", async () => {
    const started = createDeferred<void>();
    const pending = createDeferred<Response>();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const env = await mappedEnv();
    const payload = await signPayload(closedData());
    let settled = false;
    const request = postCallback("/callbacks/thread_closed", payload, env).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(settled).toBe(false);
      expect(await env.SLACK_KV.get(noticeKey)).toBeNull();
      expect(await isThreadSessionClosed(env, "C123", "111.222", "session-1")).toBe(true);
      expect(await lookupThreadSession(env, "C123", "111.222")).toMatchObject({
        closed: true,
        teamId: "team-a",
      });
    } finally {
      pending.resolve(new Response(JSON.stringify({ ok: true, channel: "C123", ts: "111.333" })));
      await request;
    }
    const { response, ctx } = await request;
    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(slackCall(fetch, "chat.postMessage")?.body).toMatchObject({
      channel: "C123",
      thread_ts: "111.222",
      text: "this session is no longer available from this channel",
    });
    expect(env.SLACK_KV.put).toHaveBeenCalledWith(noticeKey, "1", {
      expirationTtl: 7 * 24 * 60 * 60,
    });
    expect(await env.SLACK_KV.get(noticeKey)).toBe("1");
  });

  it("returns 503 on Slack failure without marking the notice sent, then accepts one successful retry", async () => {
    const fetch = okFetchMock().mockResolvedValueOnce(
      Response.json({ ok: false, error: "ratelimited" })
    );
    const env = await mappedEnv();
    const payload = await signPayload(closedData());
    const failed = await postCallback("/callbacks/thread_closed", payload, env);
    expect(failed.response.status).toBe(503);
    expect(await env.SLACK_KV.get(noticeKey)).toBeNull();
    expect(env.SLACK_KV.put).not.toHaveBeenCalledWith(noticeKey, "1", expect.anything());
    expect(await isThreadSessionClosed(env, "C123", "111.222", "session-1")).toBe(true);
    fetch.mockClear();
    for (let index = 0; index < 2; index++) {
      const { response } = await postCallback("/callbacks/thread_closed", payload, env);
      expect(response.status).toBe(200);
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(await env.SLACK_KV.get(noticeKey)).toBe("1");
  });

  it("deduplicates coordinate-only automation closure notices without a mapping", async () => {
    const fetch = okFetchMock();
    const env = await mappedEnv(false);
    const payload = await signPayload(closedData());
    for (let index = 0; index < 2; index++) {
      const { response } = await postCallback("/callbacks/thread_closed", payload, env);
      expect(response.status).toBe(200);
    }
    expect(await env.SLACK_KV.get(closureKey)).toBe("1");
    expect(await lookupThreadSession(env, "C123", "111.222")).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns a retryable failure before posting when closure persistence fails", async () => {
    const fetch = okFetchMock();
    const env = await mappedEnv(false);
    const put = vi.mocked(env.SLACK_KV.put);
    const persist = put.getMockImplementation()!;
    put.mockImplementation(async (key, value, options) => {
      if (key === closureKey) throw new Error("KV unavailable");
      return persist(key, value, options);
    });
    const payload = await signPayload(closedData());
    const failure = await postCallback("/callbacks/thread_closed", payload, env);
    expect(failure.response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    put.mockImplementation(persist);
    const retry = await postCallback("/callbacks/thread_closed", payload, env);
    expect(retry.response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("returns 503 without posting when the sent-marker query fails", async () => {
    const fetch = okFetchMock();
    const env = await mappedEnv();
    const get = vi.mocked(env.SLACK_KV.get as (key: string, type?: string) => Promise<unknown>);
    const read = get.getMockImplementation()!;
    get.mockImplementation((key, options) => {
      if (key === noticeKey) return Promise.reject(new Error("KV unavailable"));
      return read(key, options);
    });
    const { response } = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData()),
      env
    );
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(await isThreadSessionClosed(env, "C123", "111.222", "session-1")).toBe(true);
  });

  it("returns a truthful 503 when Slack succeeds but the sent marker cannot be persisted", async () => {
    const fetch = okFetchMock();
    const env = await mappedEnv();
    const put = vi.mocked(env.SLACK_KV.put);
    const persist = put.getMockImplementation()!;
    put.mockImplementation(async (key, value, options) => {
      if (key === noticeKey) throw new Error("KV unavailable");
      return persist(key, value, options);
    });
    const { response } = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData()),
      env
    );
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(noticeKey, "1", expect.anything());
    expect(await env.SLACK_KV.get(noticeKey)).toBeNull();
    expect(await isThreadSessionClosed(env, "C123", "111.222", "session-1")).toBe(true);
  });

  it.each([
    [{ kind: "slack.activity_refresh" }, 400],
    [{ timestamp: Date.now() - 10 * 60 * 1000 }, 401],
    [{ timestamp: Date.now() + 10 * 60 * 1000 }, 401],
  ] as const)("rejects domain or freshness violations %s", async (override, status) => {
    const fetch = okFetchMock();
    const { response, ctx } = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData(override))
    );
    expect(response.status).toBe(status);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures and tombstones an old session without altering a different mapping", async () => {
    const fetch = okFetchMock();
    const env = await mappedEnv();
    const invalid = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData(), "wrong"),
      env
    );
    expect(invalid.response.status).toBe(401);
    const mismatch = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData({ sessionId: "other" })),
      env
    );
    expect(mismatch.response.status).toBe(200);
    expect(await lookupThreadSession(env, "C123", "111.222")).not.toHaveProperty("closed");
    expect(env.SLACK_KV.put).toHaveBeenCalledWith(
      "thread-closed:C123:111.222:other",
      "1",
      expect.anything()
    );
    expect(await isThreadSessionClosed(env, "C123", "111.222", "other")).toBe(true);
    expect(await isThreadSessionClosed(env, "C123", "111.222", "session-1")).toBe(false);
    expect(mismatch.ctx.waitUntil).not.toHaveBeenCalled();
    expect(await env.SLACK_KV.get("thread-closed:C123:111.222:other:notice")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("suppresses late callbacks after a coordinate-only closure whose notice failed", async () => {
    const fetch = okFetchMock().mockRejectedValueOnce(new Error("network down"));
    const env = await mappedEnv(false);
    const closed = await postCallback(
      "/callbacks/thread_closed",
      await signPayload(closedData()),
      env
    );
    expect(closed.response.status).toBe(503);
    expect(await env.SLACK_KV.get(closureKey)).toBe("1");
    expect(await env.SLACK_KV.get(noticeKey)).toBeNull();
    fetch.mockClear();
    const { context } = await makeToolCallPayload();
    const payloads = [
      ["/callbacks/tool_call", { tool: "read", args: {}, callId: "call" }],
      ["/callbacks/activity", { kind: "slack.activity_refresh", messageId: "msg" }],
      ["/callbacks/complete", { messageId: "msg", success: true }],
    ] as const;
    for (const [path, fields] of payloads) {
      const { response, ctx } = await postCallback(
        path,
        await signPayload({ sessionId: "session-1", timestamp: Date.now(), context, ...fields }),
        env
      );
      expect(response.status).toBe(200);
      await flushWaitUntil(ctx);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(env.SLACK_COMPLETION_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe("POST /callbacks/complete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function completeCallbackData(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: "session-1",
      messageId: "message-1",
      success: true,
      timestamp: 1778900000000,
      context: {
        source: "slack",
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
      },
      ...overrides,
    };
  }

  it("rejects a partial completion payload", async () => {
    const payload = await signPayload(
      completeCallbackData({
        context: {
          source: "slack",
          channel: "C123",
          threadTs: "111.222",
        },
      })
    );
    const { response, ctx } = await postCallback("/callbacks/complete", payload);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("awaits durable enqueue and strips callback-only fields", async () => {
    const pending = createDeferred<void>();
    const env = makeEnv({
      SLACK_COMPLETION_QUEUE: {
        send: vi.fn(() => pending.promise),
      } as unknown as Queue,
    });
    const payload = await signPayload(
      completeCallbackData({
        extraTopLevel: "preserve-me",
        context: {
          source: "slack",
          channel: "C123",
          threadTs: "111.222",
          repoFullName: "acme/app",
          model: "anthropic/claude-haiku-4-5",
          extraNested: "preserve-me-too",
        },
      })
    );
    let settled = false;
    const responsePromise = postCallback("/callbacks/complete", payload, env).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    const { response, ctx } = await responsePromise;

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(env.SLACK_COMPLETION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        source: "session",
        sessionId: "session-1",
        messageId: "message-1",
        channel: "C123",
        threadTs: "111.222",
        traceId: "trace-1",
      }),
      { contentType: "json" }
    );
    const queued = vi.mocked(env.SLACK_COMPLETION_QUEUE.send).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(queued).not.toHaveProperty("signature");
    expect(queued).not.toHaveProperty("extraTopLevel");
  });

  it("queues an automation-sourced job when the context carries an automation id", async () => {
    const env = makeEnv();
    const payload = await signPayload(
      completeCallbackData({
        context: {
          source: "slack",
          channel: "C123",
          threadTs: "111.222",
          repoFullName: "acme/app",
          model: "anthropic/claude-haiku-4-5",
          automationId: "automation-1",
        },
      })
    );

    const { response } = await postCallback("/callbacks/complete", payload, env);

    expect(response.status).toBe(200);
    // A thread follow-up on an automation completes through this interactive
    // route; without the marker it would be ineligible to decline a reply.
    expect(env.SLACK_COMPLETION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ source: "automation" }),
      { contentType: "json" }
    );
  });

  it("returns 503 when enqueue fails", async () => {
    const env = makeEnv({
      SLACK_COMPLETION_QUEUE: {
        send: vi.fn(async () => {
          throw new Error("queue unavailable");
        }),
      } as unknown as Queue,
    });
    const payload = await signPayload(completeCallbackData());

    const { response, ctx } = await postCallback("/callbacks/complete", payload, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "completion enqueue failed" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

describe("POST /callbacks/automation-complete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function completeData(overrides: Record<string, unknown> = {}) {
    return {
      channel: "C123",
      reactionMessageTs: "111.222",
      sessionId: "session-9",
      messageId: "msg-9",
      success: true,
      repoFullName: "acme/app",
      model: "anthropic/claude-haiku-4-5",
      ...overrides,
    };
  }

  it("rejects an invalid payload", async () => {
    const { response, ctx } = await postCallback("/callbacks/automation-complete", {
      channel: "C123",
    });
    expect(response.status).toBe(400);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a bad signature", async () => {
    const payload = await signPayload(completeData(), "wrong-secret");
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload);
    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects payloads without complete session coordinates", async () => {
    const { sessionId: _, messageId: __, ...incomplete } = completeData();
    const payload = await signPayload(incomplete);
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload);

    expect(response.status).toBe(400);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("enqueues the same completion job shape without waitUntil", async () => {
    const env = makeEnv();
    const payload = await signPayload(completeData());
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload, env);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(env.SLACK_COMPLETION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "automation",
        sessionId: "session-9",
        messageId: "msg-9",
        channel: "C123",
        threadTs: "111.222",
        reactionMessageTs: "111.222",
      }),
      { contentType: "json" }
    );
  });
});

describe("POST /callbacks/automation-skip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function skipData(overrides: Record<string, unknown> = {}) {
    return { channel: "C123", user: "U9", threadTs: "111.222", ...overrides };
  }

  it("rejects an invalid payload", async () => {
    const { response, ctx } = await postCallback("/callbacks/automation-skip", { channel: "C123" });
    expect(response.status).toBe(400);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("rejects a signed automation-skip payload with malformed fields", async () => {
    const payload = await signPayload(skipData({ channel: 123 }));
    const { response, ctx } = await postCallback("/callbacks/automation-skip", payload);

    expect(response.status).toBe(400);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed automation-skip payload with reordered fields", async () => {
    okFetchMock();
    const payload = await signPayload({ threadTs: "111.222", user: "U9", channel: "C123" });
    const { response, ctx } = await postCallback("/callbacks/automation-skip", payload);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await expect(flushWaitUntil(ctx)).resolves.toBeUndefined();
  });

  it("rejects a bad signature", async () => {
    const payload = await signPayload(skipData(), "wrong-secret");
    const { response, ctx } = await postCallback("/callbacks/automation-skip", payload);
    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("posts an ephemeral notice to the message author", async () => {
    const fetchMock = okFetchMock();
    const payload = await signPayload(skipData());
    const { response, ctx } = await postCallback("/callbacks/automation-skip", payload);

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const ephemeral = slackCall(fetchMock, "chat.postEphemeral");
    expect(ephemeral).toBeDefined();
    expect(ephemeral!.body).toMatchObject({ channel: "C123", user: "U9", thread_ts: "111.222" });
  });

  it("does not crash when the ephemeral post throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const payload = await signPayload(skipData());
    const { response, ctx } = await postCallback("/callbacks/automation-skip", payload);

    expect(response.status).toBe(200);
    // The fire-and-forget handler must swallow the throw, not reject in waitUntil.
    await expect(flushWaitUntil(ctx)).resolves.toBeUndefined();
  });
});
