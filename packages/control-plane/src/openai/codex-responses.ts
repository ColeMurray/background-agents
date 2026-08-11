import { waitForAbort } from "./bounded-json-sse";
import { parseOpenAIResponsesStream } from "./responses-stream";

const CODEX_SUBSCRIPTION_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESPONSES_TIMEOUT_MS = 30_000;

export type OpenAICodexFunctionRequest = {
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

type OpenAICodexResult =
  | { kind: "completed"; output: unknown }
  | { kind: "upstream_error"; status?: number }
  | { kind: "invalid_response" };

function buildHeaders(request: OpenAICodexFunctionRequest): Headers {
  const headers = new Headers({
    authorization: `Bearer ${request.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: "opencode",
    "session-id": request.traceId,
    "x-client-request-id": request.requestId,
  });
  if (request.accountId) headers.set("ChatGPT-Account-Id", request.accountId);
  return headers;
}

function buildBody(request: OpenAICodexFunctionRequest): string {
  return JSON.stringify({
    model: request.model,
    instructions: request.systemPrompt,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request.prompt }],
      },
    ],
    tools: [{ type: "function", ...request.tool, strict: true }],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  });
}

/** Executes one standard Responses function call through the Codex subscription endpoint. */
export async function requestOpenAICodexFunction(
  request: OpenAICodexFunctionRequest
): Promise<OpenAICodexResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CODEX_RESPONSES_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await waitForAbort(
        fetch(CODEX_SUBSCRIPTION_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: buildHeaders(request),
          signal: abortController.signal,
          body: buildBody(request),
        }),
        abortController.signal
      );
    } catch {
      return { kind: "upstream_error" };
    }

    if (!response.ok) return { kind: "upstream_error", status: response.status };
    return await parseOpenAIResponsesStream(response, abortController.signal, request.tool.name);
  } finally {
    clearTimeout(timeout);
  }
}
