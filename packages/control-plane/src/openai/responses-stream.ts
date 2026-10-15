import { BoundedJsonSseAbortError, decodeBoundedJsonSse } from "./bounded-json-sse";
import { InvalidOpenAICodexResponseError, OpenAICodexUpstreamError } from "./codex-errors";

const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;
const RESPONSES_SSE_LIMITS = {
  maxTotalBytes: 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxEvents: 1_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completedOutput(response: unknown, toolName: string): unknown {
  if (!isRecord(response) || !Array.isArray(response.output)) {
    throw new InvalidOpenAICodexResponseError("Completed response has no output");
  }
  const calls = response.output.filter((item) => isRecord(item) && item.type === "function_call");
  const call: unknown = calls[0];
  if (
    calls.length !== 1 ||
    !isRecord(call) ||
    call.name !== toolName ||
    typeof call.arguments !== "string" ||
    new TextEncoder().encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES
  ) {
    throw new InvalidOpenAICodexResponseError("Invalid completed function-call output");
  }
  try {
    return JSON.parse(call.arguments);
  } catch {
    throw new InvalidOpenAICodexResponseError("Invalid completed function-call arguments");
  }
}

/**
 * Only response.completed.response.output is authoritative. Intermediate
 * snapshots and deltas are ignored; a completed response must contain exactly
 * one call to the requested function, whose arguments are parsed once.
 */
export async function parseOpenAIResponsesStream(
  response: Response,
  signal: AbortSignal,
  toolName: string
): Promise<unknown> {
  try {
    for await (const event of decodeBoundedJsonSse(response, signal, RESPONSES_SSE_LIMITS)) {
      if (!isRecord(event) || typeof event.type !== "string") {
        throw new InvalidOpenAICodexResponseError("Invalid OpenAI Responses event");
      }
      if (
        event.type === "error" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        throw new OpenAICodexUpstreamError("OpenAI Responses stream reported an error");
      }
      if (event.type === "response.completed") return completedOutput(event.response, toolName);
    }
  } catch (error) {
    if (error instanceof BoundedJsonSseAbortError || signal.aborted) {
      throw new OpenAICodexUpstreamError("OpenAI Responses stream aborted", undefined, {
        cause: error,
      });
    }
    if (
      error instanceof OpenAICodexUpstreamError ||
      error instanceof InvalidOpenAICodexResponseError
    )
      throw error;
    throw new InvalidOpenAICodexResponseError("Invalid OpenAI Responses stream", { cause: error });
  }
  throw new InvalidOpenAICodexResponseError("OpenAI Responses stream ended before completion");
}
