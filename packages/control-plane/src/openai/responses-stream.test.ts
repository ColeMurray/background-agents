import { describe, expect, it } from "vitest";
import { InvalidOpenAICodexResponseError, OpenAICodexUpstreamError } from "./codex-errors";
import { parseOpenAIResponsesStream } from "./responses-stream";

const TOOL_NAME = "classify_target";
const output = { reasoning: "The API is named.", confidence: "high", targetId: "acme/api" };

function sseResponse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

function functionCall(argumentsValue = JSON.stringify(output)): Record<string, unknown> {
  return {
    type: "function_call",
    name: TOOL_NAME,
    arguments: argumentsValue,
  };
}

function parse(...events: unknown[]) {
  return parseOpenAIResponsesStream(
    sseResponse(...events),
    new AbortController().signal,
    TOOL_NAME
  );
}

describe("OpenAI Responses stream reducer", () => {
  it.each([
    ["non-object event", null],
    ["delta without an item id", { type: "response.function_call_arguments.delta", delta: "{}" }],
    [
      "oversized argument delta",
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        delta: "x".repeat(33 * 1_024),
      },
    ],
    [
      "done event without an item id",
      { type: "response.function_call_arguments.done", arguments: "{}" },
    ],
    [
      "oversized done arguments",
      {
        type: "response.function_call_arguments.done",
        item_id: "fc-1",
        arguments: "x".repeat(33 * 1_024),
      },
    ],
  ])("rejects %s", async (_name, event) => {
    await expect(parse(event)).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it.each([
    ["an error event", { type: "error", message: "upstream failure" }],
    ["a failed response", { type: "response.failed", response: {} }],
  ])("maps %s to an upstream error", async (_name, event) => {
    await expect(parse(event)).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
  });

  it("rejects a stream that ends without a completed response", async () => {
    await expect(
      parse({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc-1", name: TOOL_NAME, arguments: "" },
      })
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it.each([
    ["non-function output", { type: "message", content: [] }],
    ["wrong tool", { ...functionCall(), name: "another_tool" }],
    ["oversized tool arguments", functionCall("x".repeat(33 * 1_024))],
  ])("rejects a completed response with %s", async (_name, item) => {
    await expect(
      parse({ type: "response.completed", response: { output: [item] } })
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("uses the tool name supplied by an arguments-done event", async () => {
    await expect(
      parse(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc-1", arguments: "" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc-1",
          name: TOOL_NAME,
          arguments: JSON.stringify(output),
        },
        { type: "response.completed", response: {} }
      )
    ).resolves.toEqual(output);
  });

  it("assembles function-call argument deltas", async () => {
    const argumentsValue = JSON.stringify(output);

    await expect(
      parse(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc-1", name: TOOL_NAME, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc-1",
          delta: argumentsValue.slice(0, 20),
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc-1",
          delta: argumentsValue.slice(20),
        },
        { type: "response.completed", response: {} }
      )
    ).resolves.toEqual(output);
  });

  it("ignores unrelated events", async () => {
    await expect(
      parse(
        { type: "response.created", response: {} },
        { type: "response.completed", response: { output: [functionCall()] } }
      )
    ).resolves.toEqual(output);
  });

  it("ignores a non-function output item before the completed response", async () => {
    await expect(
      parse(
        { type: "response.output_item.done", item: { type: "message", content: [] } },
        {
          type: "response.completed",
          response: { output: [functionCall()] },
        }
      )
    ).resolves.toEqual(output);
  });

  it("normalizes malformed SSE as an invalid response", async () => {
    const response = new Response("data: not-json\n\n");

    await expect(
      parseOpenAIResponsesStream(response, new AbortController().signal, TOOL_NAME)
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("throws an upstream error for an aborted stream", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      parseOpenAIResponsesStream(sseResponse(), controller.signal, TOOL_NAME)
    ).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
  });

  it("gives an abort precedence over a malformed event already read from the stream", async () => {
    const controller = new AbortController();
    const event = new TextEncoder().encode("data: null\n\n");
    const response = new Response(
      new ReadableStream({
        pull(streamController) {
          streamController.enqueue(event);
          streamController.close();
          queueMicrotask(() => controller.abort());
        },
      })
    );

    await expect(
      parseOpenAIResponsesStream(response, controller.signal, TOOL_NAME)
    ).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
  });
});
