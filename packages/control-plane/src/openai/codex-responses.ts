import { waitForAbort } from "./bounded-json-sse";
import { OpenAICodexUpstreamError } from "./codex-errors";
import { parseOpenAIResponsesStream } from "./responses-stream";
import { SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS } from "@open-inspect/shared/slack-classification";
import type { FetchClient } from "../platform-ports";

const CODEX_SUBSCRIPTION_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export type OpenAICodexFunctionRequest = {
  accessToken: string;
  accountId?: string;
  requestId: string;
  traceId: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  tool: { name: string; description: string; parameters: object };
  deadlineAt?: number;
};

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

/** Executes one Responses function call via the required VPC egress binding. */
export async function requestOpenAICodexFunction(
  request: OpenAICodexFunctionRequest,
  egress: FetchClient
): Promise<unknown> {
  const deadlineAt =
    request.deadlineAt ?? Date.now() + SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS;
  const headers = buildHeaders(request);
  const body = buildBody(request);
  const timeoutMs = deadlineAt - Date.now();
  if (timeoutMs <= 0) throw new OpenAICodexUpstreamError("OpenAI Codex request deadline exceeded");
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await waitForAbort(
        egress.fetch(CODEX_SUBSCRIPTION_RESPONSES_ENDPOINT, {
          method: "POST",
          headers,
          signal: abortController.signal,
          body,
        }),
        abortController.signal
      );
    } catch (error) {
      throw new OpenAICodexUpstreamError("OpenAI Codex request failed", undefined, {
        cause: error,
      });
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenAICodexUpstreamError(
        `OpenAI Codex request failed with status ${response.status}`,
        response.status
      );
    }
    return await parseOpenAIResponsesStream(response, abortController.signal, request.tool.name);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
