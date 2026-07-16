import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { computeHmacHex } from "@open-inspect/shared";
import { callbacksRouter } from "./callbacks";
import { extractAgentResponse } from "./completion/extractor";
import { deliverMediaArtifacts } from "./completion/media-upload";
import type * as ExtractorModule from "./completion/extractor";
import type * as MediaUploadModule from "./completion/media-upload";
import type { Env } from "./types";

// The automation-complete post path reuses the interactive completion path, which
// fetches the agent's response from the control-plane. Stub that extraction so the
// handler test asserts the in-thread post + reaction clear without reconstructing
// the event-fetch protocol.
vi.mock("./completion/extractor", async (importOriginal) => {
  const actual = await importOriginal<typeof ExtractorModule>();
  return { ...actual, extractAgentResponse: vi.fn() };
});

vi.mock("./completion/media-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof MediaUploadModule>();
  return { ...actual, deliverMediaArtifacts: vi.fn() };
});

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
    vi.mocked(deliverMediaArtifacts).mockReset();
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

  it("accepts signed completion payloads without stripping unknown signed fields", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "All set.",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    const fetchMock = okFetchMock();
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
    const { response, ctx } = await postCallback("/callbacks/complete", payload);

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const post = slackCall(fetchMock, "chat.postMessage");
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ channel: "C123", thread_ts: "111.222" });
  });

  it("delivers extracted media into the completion thread", async () => {
    const mediaArtifact = {
      id: "image-1",
      type: "screenshot" as const,
      mimeType: "image/png",
      sizeBytes: 123,
      caption: "Revenue chart",
    };
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Generated the chart.",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [mediaArtifact],
      success: true,
    });
    vi.mocked(deliverMediaArtifacts).mockResolvedValue({ uploaded: 1, failed: 0, skipped: 0 });
    okFetchMock();
    const payload = await signPayload(completeCallbackData());

    const { ctx } = await postCallback("/callbacks/complete", payload);
    await flushWaitUntil(ctx);

    expect(deliverMediaArtifacts).toHaveBeenCalledWith({
      env: expect.any(Object),
      sessionId: "session-1",
      messageId: "message-1",
      channel: "C123",
      threadTs: "111.222",
      artifacts: [mediaArtifact],
      traceId: "trace-1",
    });
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

  it("clears the reaction without posting when the run carries no session coordinates", async () => {
    // No sessionId/messageId (e.g. version skew) — falls back to a reaction clear.
    const fetchMock = okFetchMock();
    const payload = await signPayload(completeData());
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload);

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    expect(slackCall(fetchMock, "chat.postMessage")).toBeUndefined();
    const reaction = slackCall(fetchMock, "reactions.remove");
    expect(reaction).toBeDefined();
    expect(reaction!.body).toMatchObject({ channel: "C123", timestamp: "111.222", name: "eyes" });
  });

  it("posts the agent result in-thread and clears the reaction", async () => {
    vi.mocked(extractAgentResponse).mockResolvedValue({
      textContent: "Fixed the bug and opened a PR.",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: true,
    });
    const fetchMock = okFetchMock();
    const payload = await signPayload(
      completeData({
        sessionId: "session-9",
        messageId: "msg-9",
        success: true,
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
      })
    );
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload);

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    // The agent's response is posted into the triggering message's thread.
    const post = slackCall(fetchMock, "chat.postMessage");
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ channel: "C123", thread_ts: "111.222" });
    expect(JSON.stringify(post!.body)).toContain("Fixed the bug");

    // ...and the eyes reaction is still cleared.
    const reaction = slackCall(fetchMock, "reactions.remove");
    expect(reaction).toBeDefined();
    expect(reaction!.body).toMatchObject({ channel: "C123", timestamp: "111.222", name: "eyes" });
  });

  it("does not crash when clearing the reaction throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const payload = await signPayload(completeData());
    const { response, ctx } = await postCallback("/callbacks/automation-complete", payload);

    expect(response.status).toBe(200);
    // The fire-and-forget handler must swallow the throw, not reject in waitUntil.
    await expect(flushWaitUntil(ctx)).resolves.toBeUndefined();
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
