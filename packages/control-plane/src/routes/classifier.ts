import {
  CLASSIFY_TARGET_TOOL_NAME,
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
const CLASSIFIER_MODEL = "openai/gpt-5.6-luna";
const OPENAI_MODEL = "gpt-5.6-luna";
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function extractDecision(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("output" in body)) return null;
  const output = body.output;
  if (!Array.isArray(output)) return null;

  const functionCall = output.find(
    (item): item is { type: "function_call"; name: string; arguments: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "function_call" &&
      "name" in item &&
      item.name === CLASSIFY_TARGET_TOOL_NAME &&
      "arguments" in item &&
      typeof item.arguments === "string"
  );
  if (!functionCall) return null;

  try {
    return JSON.parse(functionCall.arguments);
  } catch {
    return null;
  }
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
  if (parsedRequest.data.model !== CLASSIFIER_MODEL) {
    return error("Unsupported classifier model", 400);
  }

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("OpenAI OAuth is not configured", 503);
  }

  const broker = new OpenAITokenBroker(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY, logger);
  const tokenResult = await broker.refreshGlobal();
  if (!tokenResult.ok) {
    const status = tokenResult.status === 404 ? 503 : tokenResult.status;
    return error(
      tokenResult.status === 404 ? "OpenAI OAuth is not configured" : "OpenAI OAuth unavailable",
      status
    );
  }

  const headers = new Headers({
    authorization: `Bearer ${tokenResult.accessToken}`,
    "Content-Type": "application/json",
    originator: "opencode",
    session_id: ctx.trace_id,
  });
  if (tokenResult.accountId) headers.set("ChatGPT-Account-Id", tokenResult.accountId);

  let upstream: Response;
  try {
    upstream = await fetch(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: parsedRequest.data.prompt,
        tools: [
          {
            type: "function",
            name: CLASSIFY_TARGET_TOOL_NAME,
            description: "Select the best target for the Slack request.",
            parameters: targetClassificationJsonSchema,
            strict: true,
          },
        ],
        tool_choice: { type: "function", name: CLASSIFY_TARGET_TOOL_NAME },
        parallel_tool_calls: false,
        store: false,
        stream: false,
      }),
    });
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

  let upstreamBody: unknown;
  try {
    upstreamBody = await upstream.json();
  } catch {
    return error("Classifier returned an invalid response", 502);
  }

  const decision = targetClassificationDecisionSchema.safeParse(extractDecision(upstreamBody));
  if (!decision.success) return error("Classifier returned an invalid response", 502);

  return json({ decision: decision.data });
}

export const classifierRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/internal/classifier/infer"),
    handler: handleClassifierInference,
  },
];
