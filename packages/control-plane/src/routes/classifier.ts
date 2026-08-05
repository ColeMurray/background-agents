import {
  CLASSIFY_TARGET_TOOL_NAME,
  OPENAI_CLASSIFICATION_MODEL_ID,
  classifierInferenceRequestSchema,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
} from "@open-inspect/shared";
import { createLogger } from "../logger";
import { OpenAITokenBroker } from "../session/openai-token-refresh-service";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

const logger = createLogger("router:classifier");
const OPENAI_MODEL = "gpt-5.6-luna";
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CLASSIFIER_UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_SSE_BYTES = 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_SSE_EVENTS = 1_000;
const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;

function extractDecision(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("output" in body)) return null;
  const output = body.output;
  if (!Array.isArray(output)) return null;

  return output.map(parseFunctionCallItem).find((decision) => decision !== null) ?? null;
}

type PendingFunctionCall = {
  namespace?: string;
  name?: string;
  arguments: string;
};

type ClassifierStreamResult =
  | { kind: "completed"; decision: unknown }
  | { kind: "failed" }
  | { kind: "invalid" };

class ClassifierUpstreamAbortError extends Error {}

function waitForUpstream<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ClassifierUpstreamAbortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new ClassifierUpstreamAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (caught: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(caught);
      }
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function functionCallFromItem(value: unknown): PendingFunctionCall | null {
  if (
    !isRecord(value) ||
    value.type !== "function_call" ||
    (value.namespace !== undefined && value.namespace !== "functions") ||
    value.name !== CLASSIFY_TARGET_TOOL_NAME ||
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

function parseFunctionArguments(call: PendingFunctionCall | null): unknown {
  if (
    !call ||
    (call.namespace !== undefined && call.namespace !== "functions") ||
    call.name !== CLASSIFY_TARGET_TOOL_NAME
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

function parseFunctionCallItem(value: unknown): unknown {
  return parseFunctionArguments(functionCallFromItem(value));
}

async function parseClassifierStream(
  response: Response,
  signal: AbortSignal
): Promise<ClassifierStreamResult> {
  if (!response.body) return { kind: "invalid" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pendingCalls = new Map<string, PendingFunctionCall>();
  let completedOutputDecision: unknown = null;
  let outputItemDecision: unknown = null;
  let lineBuffer = "";
  let eventData = "";
  let totalBytes = 0;
  let eventCount = 0;

  const processEvent = (): "continue" | "completed" | "failed" | "invalid" => {
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

    if (event.type === "error" || event.type === "response.failed") return "failed";

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
      outputItemDecision = parseFunctionCallItem(event.item);
      if (outputItemDecision === null) return "invalid";
      return "continue";
    }

    if (event.type === "response.completed") {
      completedOutputDecision = extractDecision(event.response);
      return "completed";
    }

    return "continue";
  };

  try {
    while (true) {
      const { done, value } = await waitForUpstream(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) return { kind: "invalid" };
      lineBuffer += decoder.decode(value, { stream: true });

      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const result = processEvent();
          eventData = "";
          if (result === "failed") return { kind: "failed" };
          if (result === "invalid") return { kind: "invalid" };
          if (result === "completed") {
            const streamedDecision =
              outputItemDecision ??
              [...pendingCalls.values()]
                .map(parseFunctionArguments)
                .find((candidate) => candidate !== null) ??
              completedOutputDecision;
            return { kind: "completed", decision: streamedDecision };
          }
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "");
          eventData += eventData ? `\n${data}` : data;
          if (encoder.encode(eventData).byteLength > MAX_SSE_EVENT_BYTES) {
            return { kind: "invalid" };
          }
        }
        newlineIndex = lineBuffer.indexOf("\n");
      }
      if (encoder.encode(lineBuffer).byteLength > MAX_SSE_EVENT_BYTES) {
        return { kind: "invalid" };
      }
    }
  } catch (caught) {
    return caught instanceof ClassifierUpstreamAbortError || signal.aborted
      ? { kind: "failed" }
      : { kind: "invalid" };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return { kind: "invalid" };
}

export async function handleClassifierInference(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.principal?.kind !== "service" || ctx.principal.service !== "slack-bot") {
    return error("Forbidden", 403);
  }

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;

  const parsedRequest = classifierInferenceRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) return error("Invalid classifier inference request", 400);
  if (parsedRequest.data.model !== OPENAI_CLASSIFICATION_MODEL_ID) {
    return error("Unsupported classifier model", 400);
  }

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("OpenAI OAuth is not configured", 503);
  }

  const broker = new OpenAITokenBroker(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY, logger);
  const tokenResult = await broker.refreshGlobal();
  if (!tokenResult.ok) {
    return error(
      tokenResult.status === 404 ? "OpenAI OAuth is not configured" : "OpenAI OAuth unavailable",
      tokenResult.status === 404 ? 503 : 502
    );
  }

  const headers = new Headers({
    authorization: `Bearer ${tokenResult.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: "codex_cli_rs",
    session_id: ctx.trace_id,
    "x-openai-internal-codex-responses-lite": "true",
  });
  if (tokenResult.accountId) headers.set("ChatGPT-Account-Id", tokenResult.accountId);

  const abortController = new AbortController();
  const upstreamTimeout = setTimeout(() => abortController.abort(), CLASSIFIER_UPSTREAM_TIMEOUT_MS);
  try {
    let upstream: Response;
    try {
      upstream = await waitForUpstream(
        fetch(CODEX_RESPONSES_ENDPOINT, {
          method: "POST",
          headers,
          signal: abortController.signal,
          body: JSON.stringify({
            model: OPENAI_MODEL,
            input: [
              {
                type: "additional_tools",
                role: "developer",
                tools: [
                  {
                    type: "namespace",
                    name: "functions",
                    description: "",
                    tools: [
                      {
                        type: "function",
                        name: CLASSIFY_TARGET_TOOL_NAME,
                        description: "Select the best target for the Slack request.",
                        parameters: targetClassificationJsonSchema,
                        strict: true,
                      },
                    ],
                  },
                ],
              },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: parsedRequest.data.prompt }],
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
      logger.error("Classifier upstream request failed", {
        event: "classifier.upstream_failed",
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Classifier upstream unavailable", 502);
    }

    if (!upstream.ok) {
      logger.warn("Classifier upstream returned an error", {
        event: "classifier.upstream_error",
        upstream_status: upstream.status,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Classifier upstream unavailable", 502);
    }

    const streamResult = await parseClassifierStream(upstream, abortController.signal);
    if (streamResult.kind === "failed") return error("Classifier upstream unavailable", 502);
    if (streamResult.kind === "invalid") {
      return error("Classifier returned an invalid response", 502);
    }

    const decision = targetClassificationDecisionSchema.safeParse(streamResult.decision);
    if (!decision.success) return error("Classifier returned an invalid response", 502);

    return json({ decision: decision.data });
  } finally {
    clearTimeout(upstreamTimeout);
  }
}

export const classifierRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/internal/classifier/infer"),
    handler: handleClassifierInference,
  },
];
