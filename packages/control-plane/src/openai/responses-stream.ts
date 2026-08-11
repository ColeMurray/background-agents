import { BoundedJsonSseAbortError, decodeBoundedJsonSse } from "./bounded-json-sse";

const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;
const RESPONSES_SSE_LIMITS = {
  maxTotalBytes: 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxEvents: 1_000,
};

type OpenAIResponsesStreamResult =
  | { kind: "completed"; output: unknown }
  | { kind: "upstream_error" }
  | { kind: "invalid_response" };

type PendingFunctionCall = {
  name?: string;
  arguments: string;
  argumentBytes: number;
};

type ResponseState = {
  pendingCalls: Map<string, PendingFunctionCall>;
  outputItem: unknown;
  completedOutput: unknown;
};

type EventAction = "continue" | "completed" | "upstream_error" | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionCallFromItem(
  value: unknown,
  toolName: string,
  encoder: TextEncoder
): PendingFunctionCall | null {
  if (
    !isRecord(value) ||
    value.type !== "function_call" ||
    value.name !== toolName ||
    typeof value.arguments !== "string"
  ) {
    return null;
  }
  return {
    name: value.name,
    arguments: value.arguments,
    argumentBytes: encoder.encode(value.arguments).byteLength,
  };
}

function parseFunctionArguments(call: PendingFunctionCall | null, toolName: string): unknown {
  if (!call || call.name !== toolName || call.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
    return null;
  }
  try {
    return JSON.parse(call.arguments);
  } catch {
    return null;
  }
}

function parseFunctionCallItem(value: unknown, toolName: string, encoder: TextEncoder): unknown {
  return parseFunctionArguments(functionCallFromItem(value, toolName, encoder), toolName);
}

function extractCompletedOutput(body: unknown, toolName: string, encoder: TextEncoder): unknown {
  if (!isRecord(body) || !Array.isArray(body.output)) return null;
  return (
    body.output
      .map((item) => parseFunctionCallItem(item, toolName, encoder))
      .find((output) => output !== null) ?? null
  );
}

function applyFunctionCallDelta(
  state: ResponseState,
  event: Record<string, unknown>,
  encoder: TextEncoder
): EventAction {
  const itemId = typeof event.item_id === "string" ? event.item_id : null;
  if (!itemId || typeof event.delta !== "string") return "invalid";
  const call = state.pendingCalls.get(itemId) ?? { arguments: "", argumentBytes: 0 };
  call.arguments += event.delta;
  call.argumentBytes += encoder.encode(event.delta).byteLength;
  if (call.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) return "invalid";
  state.pendingCalls.set(itemId, call);
  return "continue";
}

function applyFunctionCallDone(
  state: ResponseState,
  event: Record<string, unknown>,
  encoder: TextEncoder
): EventAction {
  const itemId = typeof event.item_id === "string" ? event.item_id : null;
  if (!itemId || typeof event.arguments !== "string") return "invalid";
  const call = state.pendingCalls.get(itemId) ?? { arguments: "", argumentBytes: 0 };
  call.arguments = event.arguments;
  call.argumentBytes = encoder.encode(event.arguments).byteLength;
  if (typeof event.name === "string") call.name = event.name;
  if (call.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) return "invalid";
  state.pendingCalls.set(itemId, call);
  return "continue";
}

function applyResponseEvent(
  state: ResponseState,
  event: unknown,
  toolName: string,
  encoder: TextEncoder
): EventAction {
  if (!isRecord(event) || typeof event.type !== "string") return "invalid";
  if (event.type === "error" || event.type === "response.failed") return "upstream_error";

  if (event.type === "response.output_item.added" && isRecord(event.item)) {
    const id = typeof event.item.id === "string" ? event.item.id : null;
    if (id && event.item.type === "function_call") {
      const argumentsValue = typeof event.item.arguments === "string" ? event.item.arguments : "";
      state.pendingCalls.set(id, {
        name: typeof event.item.name === "string" ? event.item.name : undefined,
        arguments: argumentsValue,
        argumentBytes: encoder.encode(argumentsValue).byteLength,
      });
    }
    return "continue";
  }

  if (event.type === "response.function_call_arguments.delta") {
    return applyFunctionCallDelta(state, event, encoder);
  }
  if (event.type === "response.function_call_arguments.done") {
    return applyFunctionCallDone(state, event, encoder);
  }
  if (event.type === "response.output_item.done") {
    if (!isRecord(event.item) || event.item.type !== "function_call") return "continue";
    state.outputItem = parseFunctionCallItem(event.item, toolName, encoder);
    return state.outputItem === null ? "invalid" : "continue";
  }
  if (event.type === "response.completed") {
    state.completedOutput = extractCompletedOutput(event.response, toolName, encoder);
    return "completed";
  }
  return "continue";
}

function resolveOutput(state: ResponseState, toolName: string): unknown {
  return (
    state.outputItem ??
    [...state.pendingCalls.values()]
      .map((call) => parseFunctionArguments(call, toolName))
      .find((candidate) => candidate !== null) ??
    state.completedOutput
  );
}

/** Reduces bounded Responses events into one forced-function result. */
export async function parseOpenAIResponsesStream(
  response: Response,
  signal: AbortSignal,
  toolName: string
): Promise<OpenAIResponsesStreamResult> {
  const state: ResponseState = {
    pendingCalls: new Map(),
    outputItem: null,
    completedOutput: null,
  };
  const encoder = new TextEncoder();

  try {
    for await (const event of decodeBoundedJsonSse(response, signal, RESPONSES_SSE_LIMITS)) {
      const action = applyResponseEvent(state, event, toolName, encoder);
      if (action === "upstream_error") return { kind: "upstream_error" };
      if (action === "invalid") return { kind: "invalid_response" };
      if (action === "completed") {
        const output = resolveOutput(state, toolName);
        return output === null ? { kind: "invalid_response" } : { kind: "completed", output };
      }
    }
  } catch (error) {
    return error instanceof BoundedJsonSseAbortError || signal.aborted
      ? { kind: "upstream_error" }
      : { kind: "invalid_response" };
  }

  return { kind: "invalid_response" };
}
