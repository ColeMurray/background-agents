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
  it("uses terminal output instead of stale item and delta snapshots", async () => {
    const stale = { ...output, targetId: "acme/stale" };
    await expect(
      parse(
        { type: "response.output_item.added", item: { ...functionCall(""), id: "fc-1" } },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc-1",
          delta: JSON.stringify(stale),
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc-1",
          arguments: JSON.stringify(stale),
        },
        { type: "response.output_item.done", item: functionCall(JSON.stringify(stale)) },
        { type: "response.completed", response: { output: [functionCall()] } }
      )
    ).resolves.toEqual(output);
  });

  it("does not mask invalid terminal output with an earlier valid item", async () => {
    await expect(
      parse(
        { type: "response.output_item.done", item: functionCall() },
        { type: "response.completed", response: { output: [functionCall("invalid-json")] } }
      )
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });
  it.each([null, {}, { type: 1 }])("rejects an invalid event envelope: %j", async (event) => {
    await expect(parse(event)).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it.each([
    ["an error event", { type: "error", message: "upstream failure" }],
    ["a failed response", { type: "response.failed", response: {} }],
    ["an incomplete response", { type: "response.incomplete", response: {} }],
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
    ["non-string arguments", { ...functionCall(), arguments: output }],
    ["invalid JSON arguments", functionCall("invalid-json")],
  ])("rejects a completed response with %s", async (_name, item) => {
    await expect(
      parse({ type: "response.completed", response: { output: [item] } })
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("rejects multiple function calls instead of choosing one result", async () => {
    await expect(
      parse({
        type: "response.completed",
        response: { output: [functionCall(), functionCall()] },
      })
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("accepts function arguments at the byte cap with unrelated reasoning output", async () => {
    const paddingBytes = 32 * 1024 - JSON.stringify({ padding: "" }).length;
    const argumentsValue = { padding: "x".repeat(paddingBytes) };
    await expect(
      parse({
        type: "response.completed",
        response: { output: [{ type: "reasoning" }, functionCall(JSON.stringify(argumentsValue))] },
      })
    ).resolves.toEqual(argumentsValue);
  });

  it("rejects missing terminal output despite an arguments-done snapshot", async () => {
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
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
  });

  it("does not assemble argument deltas without terminal output", async () => {
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
    ).rejects.toBeInstanceOf(InvalidOpenAICodexResponseError);
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
          controller.abort();
          streamController.close();
        },
      })
    );

    await expect(
      parseOpenAIResponsesStream(response, controller.signal, TOOL_NAME)
    ).rejects.toBeInstanceOf(OpenAICodexUpstreamError);
  });
});
