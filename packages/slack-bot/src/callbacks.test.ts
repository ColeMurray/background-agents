import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { computeHmacHex } from "@open-inspect/shared";
import { callbacksRouter } from "./callbacks";
import type { Env } from "./types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    SLACK_COMPLETION_QUEUE: { send: vi.fn(async () => {}) } as unknown as Queue,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_MEDIA_DELIVERY_ENABLED: "true",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    LOG_LEVEL: "error",
    ...overrides,
  };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
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
    const { response, ctx } = await postToolCall(
      payload,
      makeEnv({ INTERNAL_CALLBACK_SECRET: "" })
    );

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
    new Response(JSON.stringify({ ok: true }), {
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
