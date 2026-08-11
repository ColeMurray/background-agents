const RESPONSES_LITE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const RESPONSES_LITE_TIMEOUT_MS = 30_000;
const MAX_SSE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_SSE_EVENTS = 1_000;
const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;

export type OpenAIResponsesLiteFunctionRequest = {
  accessToken: string;
  accountId?: string;
  requestId: string;
  traceId: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  tool: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type OpenAIResponsesLiteResult =
  | { kind: "completed"; output: unknown }
  | { kind: "upstream_error"; status?: number }
  | { kind: "invalid_response" };

type PendingFunctionCall = {
  namespace?: string;
  name?: string;
  arguments: string;
};

type StreamResult =
  | { kind: "completed"; output: unknown }
  | { kind: "upstream_error" }
  | { kind: "invalid_response" };

class ResponsesLiteAbortError extends Error {}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ResponsesLiteAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new ResponsesLiteAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function functionCallFromItem(value: unknown, toolName: string): PendingFunctionCall | null {
  if (
    !isRecord(value) ||
    value.type !== "function_call" ||
    (value.namespace !== undefined && value.namespace !== "functions") ||
    value.name !== toolName ||
    typeof value.arguments !== "string"
  ) {
    return null;
  }
  return {
    namespace: typeof value.namespace === "string" ? value.namespace : undefined,
    name: value.name,
    arguments: value.arguments,
  };
}

function parseFunctionArguments(call: PendingFunctionCall | null, toolName: string): unknown {
  if (
    !call ||
    (call.namespace !== undefined && call.namespace !== "functions") ||
    call.name !== toolName
  ) {
    return null;
  }
  if (new TextEncoder().encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES) return null;
  try {
    return JSON.parse(call.arguments);
  } catch {
    return null;
  }
}

function parseFunctionCallItem(value: unknown, toolName: string): unknown {
  return parseFunctionArguments(functionCallFromItem(value, toolName), toolName);
}

function extractOutput(body: unknown, toolName: string): unknown {
  if (!isRecord(body) || !Array.isArray(body.output)) return null;
  return (
    body.output
      .map((item) => parseFunctionCallItem(item, toolName))
      .find((output) => output !== null) ?? null
  );
}

async function parseStream(
  response: Response,
  signal: AbortSignal,
  toolName: string
): Promise<StreamResult> {
  if (!response.body) return { kind: "invalid_response" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pendingCalls = new Map<string, PendingFunctionCall>();
  let completedOutput: unknown = null;
  let outputItem: unknown = null;
  let lineBuffer = "";
  let eventData = "";
  let totalBytes = 0;
  let eventCount = 0;

  const processEvent = (): "continue" | "completed" | "upstream_error" | "invalid" => {
    if (!eventData) return "continue";
    eventCount += 1;
    if (eventCount > MAX_SSE_EVENTS || encoder.encode(eventData).byteLength > MAX_SSE_EVENT_BYTES) {
      return "invalid";
    }

    let event: unknown;
    try {
      event = JSON.parse(eventData);
    } catch {
      return "invalid";
    }
    if (!isRecord(event) || typeof event.type !== "string") return "invalid";
    if (event.type === "error" || event.type === "response.failed") return "upstream_error";

    if (event.type === "response.output_item.added" && isRecord(event.item)) {
      const id = typeof event.item.id === "string" ? event.item.id : null;
      if (id && event.item.type === "function_call") {
        pendingCalls.set(id, {
          namespace: typeof event.item.namespace === "string" ? event.item.namespace : undefined,
          name: typeof event.item.name === "string" ? event.item.name : undefined,
          arguments: typeof event.item.arguments === "string" ? event.item.arguments : "",
        });
      }
      return "continue";
    }

    if (event.type === "response.function_call_arguments.delta") {
      const itemId = typeof event.item_id === "string" ? event.item_id : null;
      if (!itemId || typeof event.delta !== "string") return "invalid";
      const call = pendingCalls.get(itemId) ?? { arguments: "" };
      call.arguments += event.delta;
      if (encoder.encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES) return "invalid";
      pendingCalls.set(itemId, call);
      return "continue";
    }

    if (event.type === "response.function_call_arguments.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : null;
      if (!itemId || typeof event.arguments !== "string") return "invalid";
      const call = pendingCalls.get(itemId) ?? { arguments: "" };
      call.arguments = event.arguments;
      if (typeof event.namespace === "string") call.namespace = event.namespace;
      if (typeof event.name === "string") call.name = event.name;
      if (encoder.encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES) return "invalid";
      pendingCalls.set(itemId, call);
      return "continue";
    }

    if (event.type === "response.output_item.done") {
      if (!isRecord(event.item) || event.item.type !== "function_call") return "continue";
      outputItem = parseFunctionCallItem(event.item, toolName);
      return outputItem === null ? "invalid" : "continue";
    }

    if (event.type === "response.completed") {
      completedOutput = extractOutput(event.response, toolName);
      return "completed";
    }
    return "continue";
  };

  try {
    while (true) {
      const { done, value } = await waitForAbort(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) return { kind: "invalid_response" };
      lineBuffer += decoder.decode(value, { stream: true });

      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const result = processEvent();
          eventData = "";
          if (result === "upstream_error") return { kind: "upstream_error" };
          if (result === "invalid") return { kind: "invalid_response" };
          if (result === "completed") {
            const output =
              outputItem ??
              [...pendingCalls.values()]
                .map((call) => parseFunctionArguments(call, toolName))
                .find((candidate) => candidate !== null) ??
              completedOutput;
            return output === null ? { kind: "invalid_response" } : { kind: "completed", output };
          }
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "");
          eventData += eventData ? `\n${data}` : data;
          if (encoder.encode(eventData).byteLength > MAX_SSE_EVENT_BYTES) {
            return { kind: "invalid_response" };
          }
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
      if (encoder.encode(lineBuffer).byteLength > MAX_SSE_EVENT_BYTES) {
        return { kind: "invalid_response" };
      }
    }
  } catch (error) {
    return error instanceof ResponsesLiteAbortError || signal.aborted
      ? { kind: "upstream_error" }
      : { kind: "invalid_response" };
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return { kind: "invalid_response" };
}

/** Executes one forced function call against the subscription Responses Lite endpoint. */
export async function requestOpenAIResponsesLiteFunction(
  request: OpenAIResponsesLiteFunctionRequest
): Promise<OpenAIResponsesLiteResult> {
  const headers = new Headers({
    authorization: `Bearer ${request.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: "open-inspect",
    "session-id": request.traceId,
    "x-client-request-id": request.requestId,
    "x-openai-internal-codex-responses-lite": "true",
  });
  if (request.accountId) headers.set("ChatGPT-Account-Id", request.accountId);

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), RESPONSES_LITE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await waitForAbort(
        fetch(RESPONSES_LITE_ENDPOINT, {
          method: "POST",
          headers,
          signal: abortController.signal,
          body: JSON.stringify({
            model: request.model,
            input: [
              {
                type: "additional_tools",
                role: "developer",
                tools: [
                  {
                    type: "namespace",
                    name: "functions",
                    description: "",
                    tools: [{ type: "function", ...request.tool, strict: true }],
                  },
                ],
              },
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: request.systemPrompt }],
              },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: request.prompt }],
              },
            ],
            tool_choice: "required",
            parallel_tool_calls: false,
            reasoning: { context: "all_turns" },
            store: false,
            stream: true,
          }),
        }),
        abortController.signal
      );
    } catch {
      return { kind: "upstream_error" };
    }

    if (!response.ok) return { kind: "upstream_error", status: response.status };
    const result = await parseStream(response, abortController.signal, request.tool.name);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
