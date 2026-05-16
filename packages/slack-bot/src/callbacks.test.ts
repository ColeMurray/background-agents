import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { computeHmacHex } from "@open-inspect/shared";
import { callbacksRouter } from "./callbacks";
import type { Env } from "./types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
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
    tool: "Read",
    args: { file_path: "src/auth.ts" },
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
        status: "Reading src/auth.ts",
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
