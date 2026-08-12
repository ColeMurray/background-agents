import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_RESPONSES_TIMEOUT_MS,
  requestOpenAICodexFunction,
  type OpenAICodexFunctionRequest,
} from "./codex-responses";
import { InvalidOpenAICodexResponseError, OpenAICodexUpstreamError } from "./codex-errors";

const TOOL_NAME = "classify_target";
const output = { targetId: "acme/api", confidence: "high" };

function functionCall(argumentsValue = JSON.stringify(output)) {
  return {
    type: "function_call",
    call_id: "call-classify",
    name: TOOL_NAME,
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
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        while (offset < body.length) {
          const size = chunkSizes[chunkIndex % chunkSizes.length];
          controller.enqueue(encoder.encode(body.slice(offset, offset + size)));
          offset += size;
          chunkIndex += 1;
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function completedFunctionCall(argumentsValue = JSON.stringify(output)): Response {
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

function request(overrides: Partial<OpenAICodexFunctionRequest> = {}) {
  return requestOpenAICodexFunction({
    accessToken: "secret-access-token",
    accountId: "account-123",
    requestId: "request-123",
    traceId: "trace-123",
    model: "gpt-5.6-luna",
    systemPrompt: "Classify the target.",
    prompt: "route this request",
    tool: {
      name: TOOL_NAME,
      description: "Select the target.",
      parameters: { type: "object", additionalProperties: false },
    },
    ...overrides,
  });
}

describe("OpenAI Codex Responses client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completedFunctionCall()));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends a correlated forced-function request and parses fragmented SSE", async () => {
    await expect(request()).resolves.toEqual(output);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-123");
    expect(headers.get("originator")).toBe("opencode");
    expect(headers.get("session-id")).toBe("trace-123");
    expect(headers.get("x-client-request-id")).toBe("request-123");
    expect(headers.has("session_id")).toBe(false);
    expect(headers.has("x-openai-internal-codex-responses-lite")).toBe(false);

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      instructions: "Classify the target.",
      tool_choice: "required",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      tools: [
        {
          type: "function",
          name: TOOL_NAME,
          description: "Select the target.",
          parameters: { type: "object", additionalProperties: false },
          strict: true,
        },
      ],
    });
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "route this request" }],
      },
    ]);
  });

  it("uses output_item.done when response.completed has no output", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        { type: "response.output_item.done", item: functionCall() },
        { type: "response.completed", response: { id: "resp-classify", output: [] } }
      )
    );

    await expect(request()).resolves.toEqual(output);
  });

  it("falls back to streamed function-call arguments", async () => {
    const argumentsValue = JSON.stringify(output);
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc-1", name: TOOL_NAME, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc-1",
          delta: argumentsValue.slice(0, 12),
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc-1",
          arguments: argumentsValue,
        },
        { type: "response.completed", response: { id: "resp-classify" } }
      )
    );

    await expect(request()).resolves.toEqual(output);
  });

  it("rejects malformed authoritative output instead of a completed fallback", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse(
        { type: "response.output_item.done", item: functionCall("not-json") },
        {
          type: "response.completed",
          response: { id: "resp-classify", output: [functionCall()] },
        }
      )
    );

    await expect(request()).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it.each([
    [
      "missing tool call",
      fragmentedSseResponse({
        type: "response.completed",
        response: { id: "resp-classify", output: [] },
      }),
    ],
    ["malformed arguments", completedFunctionCall("not-json")],
    ["malformed SSE", new Response("event: response.completed\ndata: {not-json}\n\n")],
    ["oversized SSE event", new Response(`data: ${"x".repeat(70 * 1024)}\n\n`)],
    [
      "oversized total stream",
      new Response(
        Array.from({ length: 20 }, () =>
          sseEvent({ type: "response.created", padding: "x".repeat(55 * 1024) })
        ).join("")
      ),
    ],
    [
      "too many SSE events",
      new Response(
        Array.from({ length: 1_001 }, () => sseEvent({ type: "response.created" })).join("")
      ),
    ],
  ])("rejects invalid output for %s", async (_name, response) => {
    vi.mocked(fetch).mockResolvedValueOnce(response);
    await expect(request()).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("rejects when the stream ends before a terminal event", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse({ type: "response.created", response: { id: "resp-classify" } })
    );

    await expect(request()).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it.each(["response.failed", "error"])("sanitizes %s events", async (type) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      fragmentedSseResponse({ type, error: { message: "upstream secret details" } })
    );
    await expect(request()).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
  });

  it("times out a stream whose reader and cancellation never finish", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.mocked(fetch).mockResolvedValueOnce(openStreamResponse(undefined, cancel));

    const result = request();
    const rejection = expect(result).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(CODEX_RESPONSES_TIMEOUT_MS);

    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(() => undefined));

    const result = request();
    const rejection = expect(result).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(CODEX_RESPONSES_TIMEOUT_MS);

    await rejection;
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("ignores cancellation failures and releases the stream lock", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed with secret details"));
    const response = openStreamResponse(
      sseEvent({
        type: "response.completed",
        response: { id: "resp-classify", output: [functionCall()] },
      }),
      cancel
    );
    vi.mocked(fetch).mockResolvedValueOnce(response);

    await expect(request()).resolves.toEqual(output);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("throws an upstream error for non-OK responses without reading their body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("upstream secret details", { status: 429 })
    );
    const error = await request().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAICodexUpstreamError);
    expect(error).toMatchObject({ status: 429 });
  });

  it("omits the account header when no account id is available", async () => {
    await request({ accountId: undefined });
    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });
});
