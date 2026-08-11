import {
  CLASSIFY_TARGET_TOOL_NAME,
  openAIClassifierInferenceRequestSchema,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
} from "@open-inspect/shared/types/target-classification";
import { requestOpenAIResponsesLiteFunction } from "../auth/openai-responses-lite";
import { OpenAITokenBroker } from "../auth/openai-token-broker";
import { createLogger } from "../logger";
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

  const parsedRequest = openAIClassifierInferenceRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) return error("Invalid classifier inference request", 400);

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

  const result = await requestOpenAIResponsesLiteFunction({
    accessToken: tokenResult.accessToken,
    accountId: tokenResult.accountId,
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
    model: OPENAI_MODEL,
    systemPrompt: parsedRequest.data.systemPrompt,
    prompt: parsedRequest.data.prompt,
    tool: {
      name: CLASSIFY_TARGET_TOOL_NAME,
      description: "Select the best target for the Slack request.",
      parameters: targetClassificationJsonSchema,
    },
  });

  if (result.kind === "upstream_error") {
    logger.warn("Classifier upstream unavailable", {
      event: "classifier.upstream_error",
      upstream_status: result.status,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Classifier upstream unavailable", 502);
  }
  if (result.kind === "invalid_response") {
    return error("Classifier returned an invalid response", 502);
  }

  const decision = targetClassificationDecisionSchema.safeParse(result.output);
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
