import { CLASSIFIER_PROMPT_MAX_CHARS, CLASSIFY_TARGET_TOOL_NAME } from "@open-inspect/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpenAITokenRefreshModule from "../session/openai-token-refresh-service";
import { handleRequest } from "../router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "../router.test-support";
import { CLASSIFIER_UPSTREAM_TIMEOUT_MS } from "./classifier";

const brokerState = vi.hoisted(() => ({
  refreshGlobal: vi.fn(),
}));

vi.mock("../session/openai-token-refresh-service", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAITokenRefreshModule>();
  return {
    ...actual,
    OpenAITokenBroker: class {
      refreshGlobal = brokerState.refreshGlobal;
    },
  };
});

const env = {
  ...TEST_SERVICE_SECRETS,
  REPO_SECRETS_ENCRYPTION_KEY: "encryption-key",
  SCM_PROVIDER: "github",
  DB: {
    prepare: vi.fn(),
    batch: vi.fn(),
  },
};

const decision = {
  targetId: "acme/api",
  confidence: "high",
  reasoning: "The request names the API.",
  alternatives: [],
};

function functionCall(argumentsValue = JSON.stringify(decision)) {
  return {
    type: "function_call",
    call_id: "call-classify",
    namespace: "functions",
    name: CLASSIFY_TARGET_TOOL_NAME,
    arguments: argumentsValue,
  };
}

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function fragmentedSseResponse(...events: Array<Record<string, unknown>>): Response {
  const body = events.map(sseEvent).join("");
  const encoder = new TextEncoder();
  const chunkSizes = [1, 2, 7, 3, 19, 5, 11];
  let offset = 0;
  let chunkIndex = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      while (offset < body.length) {
        const size = chunkSizes[chunkIndex % chunkSizes.length];
        controller.enqueue(encoder.encode(body.slice(offset, offset + size)));
        offset += size;
        chunkIndex += 1;
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function completedFunctionCall(argumentsValue = JSON.stringify(decision)): Response {
  return fragmentedSseResponse({
    type: "response.completed",
    response: { id: "resp-classify", output: [functionCall(argumentsValue)] },
  });
}

function openStreamResponse(
  initialBody: string | undefined,
  cancel: () => void | Promise<void>
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (initialBody !== undefined) controller.enqueue(encoder.encode(initialBody));
      },
      cancel,
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

async function classifierRequest(
  body: unknown,
  service: "slack-bot" | "github-bot" = "slack-bot"
): Promise<Response> {
  const serialized = JSON.stringify(body);
  return handleRequest(
    await signedServiceRequest("https://internal/internal/classifier/infer", {
      method: "POST",
      body: serialized,
      service,
    }),
    env as never
  );
}

describe("POST /internal/classifier/infer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerState.refreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "secret-access-token",
      expiresIn: 1800,
      accountId: "account-123",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completedFunctionCall()));
  });

  it("rejects requests without service authentication", async () => {
    const response = await handleRequest(
      new Request("https://internal/internal/classifier/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.6-luna", prompt: "route this" }),
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it("allows only the slack-bot service principal", async () => {
    const response = await classifierRequest(
      { model: "openai/gpt-5.6-luna", prompt: "route this" },
      "github-bot"
    );

    expect(response.status).toBe(403);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it.each([
    ["missing prompt", { model: "openai/gpt-5.6-luna" }],
    ["empty prompt", { model: "openai/gpt-5.6-luna", prompt: "" }],
    ["unknown field", { model: "openai/gpt-5.6-luna", prompt: "route", extra: true }],
    [
      "oversized prompt",
      { model: "openai/gpt-5.6-luna", prompt: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1) },
    ],
  ])("rejects invalid input: %s", async (_name, body) => {
    const response = await classifierRequest(body);

    expect(response.status).toBe(400);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it("rejects classifier models other than OpenAI Luna", async () => {
    const response = await classifierRequest({
      model: "anthropic/claude-haiku-4-5",
      prompt: "route this",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported classifier model" });
  });

  it("returns 503 without configured global OAuth", async () => {
    brokerState.refreshGlobal.mockResolvedValue({
      ok: false,
      status: 404,
      error: "OPENAI_OAUTH_REFRESH_TOKEN not configured",
    });

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the forced strict function request to the Codex Responses endpoint", async () => {
    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this request",
    });

    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-123");
    expect(headers.get("originator")).toBe("codex_cli_rs");
    expect(headers.get("session_id")).toBeTruthy();
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    const upstreamBody = JSON.parse(String(init?.body));
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.6-luna",
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning: { context: "all_turns" },
      store: false,
      stream: true,
    });
    expect(upstreamBody).not.toHaveProperty("tools");
    expect(upstreamBody.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              expect.objectContaining({
                type: "function",
                name: CLASSIFY_TARGET_TOOL_NAME,
                strict: true,
                parameters: expect.objectContaining({ additionalProperties: false }),
              }),
            ],
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "route this request" }],
      },
    ]);
    await expect(response.json()).resolves.toEqual({ decision });
  });

  it("uses output_item.done when response.completed has no output", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        { type: "response.created", response: { id: "resp-classify" } },
        { type: "response.output_item.done", item: functionCall() },
        { type: "response.completed", response: { id: "resp-classify", output: [] } }
      )
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decision });
  });

  it("rejects malformed authoritative output instead of using completed fallback", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        {
          type: "response.output_item.done",
          item: functionCall("not-json"),
        },
        {
          type: "response.completed",
          response: { id: "resp-classify", output: [functionCall()] },
        }
      )
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it("falls back to streamed function-call arguments", async () => {
    const argumentsValue = JSON.stringify(decision);
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "fc-classify",
            name: CLASSIFY_TARGET_TOOL_NAME,
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc-classify",
          delta: argumentsValue.slice(0, 17),
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc-classify",
          arguments: argumentsValue,
        },
        { type: "response.completed", response: { id: "resp-classify" } }
      )
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decision });
  });

  it("omits the account header when the token has no account id", async () => {
    brokerState.refreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "secret-access-token",
      expiresIn: 1800,
    });

    await classifierRequest({ model: "openai/gpt-5.6-luna", prompt: "route this" });

    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });

  it.each([
    [
      "missing tool call",
      fragmentedSseResponse({
        type: "response.completed",
        response: { id: "resp-classify", output: [] },
      }),
    ],
    ["malformed JSON arguments", completedFunctionCall("not-json")],
    [
      "invalid decision",
      completedFunctionCall(JSON.stringify({ ...decision, confidence: "certain" })),
    ],
    [
      "function call from another namespace",
      fragmentedSseResponse(
        {
          type: "response.output_item.done",
          item: { ...functionCall(), namespace: "other" },
        },
        { type: "response.completed", response: { id: "resp-classify" } }
      ),
    ],
    [
      "completed fallback from another namespace",
      fragmentedSseResponse({
        type: "response.completed",
        response: {
          id: "resp-classify",
          output: [{ ...functionCall(), namespace: "other" }],
        },
      }),
    ],
    ["malformed SSE", new Response("event: response.completed\ndata: {not-json}\n\n")],
    [
      "oversized SSE event",
      new Response(`data: ${"x".repeat(70 * 1024)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ],
  ])("returns 502 for %s", async (_name, upstreamResponse) => {
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse);

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it.each(["response.failed", "error"])("sanitizes %s events", async (type) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse({ type, error: { message: "upstream secret details" } })
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    const responseText = await response.text();
    expect(responseText).toBe(JSON.stringify({ error: "Classifier upstream unavailable" }));
    expect(responseText).not.toContain("upstream secret details");
  });

  it("times out a never-ending upstream stream and cancels its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(openStreamResponse(undefined, cancel));

    try {
      const responsePromise = classifierRequest({
        model: "openai/gpt-5.6-luna",
        prompt: "route this",
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(CLASSIFIER_UPSTREAM_TIMEOUT_MS);

      const response = await responsePromise;
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "Classifier upstream unavailable",
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out even when the fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => undefined));

    try {
      const responsePromise = classifierRequest({
        model: "openai/gpt-5.6-luna",
        prompt: "route this",
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(CLASSIFIER_UPSTREAM_TIMEOUT_MS);

      const response = await responsePromise;
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "Classifier upstream unavailable",
      });
      expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores reader cancellation failures and releases the lock", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed with secret details"));
    const upstream = openStreamResponse(
      sseEvent({
        type: "response.completed",
        response: { id: "resp-classify", output: [functionCall()] },
      }),
      cancel
    );
    vi.mocked(fetch).mockResolvedValueOnce(upstream);

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ decision });
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream.body?.locked).toBe(false);
  });

  it("maps broker authorization failure to 502 for the authenticated caller", async () => {
    brokerState.refreshGlobal.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "refresh token rejected",
    });

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps non-OK upstream responses without returning their body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("upstream secret details", { status: 429 })
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    const responseText = await response.text();
    expect(responseText).toBe(JSON.stringify({ error: "Classifier upstream unavailable" }));
    expect(responseText).not.toContain("secret-access-token");
    expect(responseText).not.toContain("upstream secret details");
  });
});
