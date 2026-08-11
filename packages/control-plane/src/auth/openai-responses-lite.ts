import { waitForAbort } from "./bounded-json-sse";
import { parseOpenAIResponsesLiteStream } from "./openai-responses-lite-stream";

const CODEX_SUBSCRIPTION_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const RESPONSES_LITE_TIMEOUT_MS = 30_000;

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

function buildHeaders(request: OpenAIResponsesLiteFunctionRequest): Headers {
  const headers = new Headers({
    authorization: `Bearer ${request.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: "opencode",
    "session-id": request.traceId,
    "x-client-request-id": request.requestId,
    "x-openai-internal-codex-responses-lite": "true",
  });
  if (request.accountId) headers.set("ChatGPT-Account-Id", request.accountId);
  return headers;
}

function buildBody(request: OpenAIResponsesLiteFunctionRequest): string {
  return JSON.stringify({
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
  });
}

/**
 * Executes one forced function call using Codex's internal Responses Lite mode.
 * This is not the public OpenAI Responses API.
 */
export async function requestOpenAIResponsesLiteFunction(
  request: OpenAIResponsesLiteFunctionRequest
): Promise<OpenAIResponsesLiteResult> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), RESPONSES_LITE_TIMEOUT_MS);
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
    return await parseOpenAIResponsesLiteStream(
      response,
      abortController.signal,
      request.tool.name
    );
  } finally {
    clearTimeout(timeout);
  }
}
