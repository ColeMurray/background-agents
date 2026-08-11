import {
  buildTargetClassificationPrompt,
  CLASSIFY_TARGET_TOOL_NAME,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
  TargetClassificationPromptTooLongError,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
  type TargetClassificationDecision,
  type TargetClassificationRequest,
} from "@open-inspect/shared/types/target-classification";
import { OpenAITokenBroker } from "../auth/openai-token-broker";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { requestOpenAICodexFunction } from "../openai/codex-responses";

const logger = createLogger("target-classifications");
const OPENAI_MODEL = "gpt-5.6-luna";

type CreateTargetClassificationResult =
  | { kind: "completed"; classification: TargetClassificationDecision }
  | { kind: "prompt_too_long" }
  | { kind: "oauth_not_configured" }
  | { kind: "oauth_unavailable" }
  | { kind: "upstream_unavailable" }
  | { kind: "invalid_response" };

type TargetClassificationServiceContext = {
  db: SqlDatabase;
  encryptionKey: string;
  requestId: string;
  traceId: string;
};

export async function createTargetClassification(
  request: TargetClassificationRequest,
  context: TargetClassificationServiceContext
): Promise<CreateTargetClassificationResult> {
  let prompt: string;
  try {
    prompt = buildTargetClassificationPrompt(request);
  } catch (error) {
    if (error instanceof TargetClassificationPromptTooLongError) {
      return { kind: "prompt_too_long" };
    }
    throw error;
  }

  const broker = new OpenAITokenBroker(context.db, context.encryptionKey, logger);
  const tokenResult = await broker.refreshGlobal();
  if (!tokenResult.ok) {
    return {
      kind: tokenResult.status === 404 ? "oauth_not_configured" : "oauth_unavailable",
    };
  }

  const result = await requestOpenAICodexFunction({
    accessToken: tokenResult.accessToken,
    accountId: tokenResult.accountId,
    requestId: context.requestId,
    traceId: context.traceId,
    model: OPENAI_MODEL,
    systemPrompt: TARGET_CLASSIFIER_SYSTEM_PROMPT,
    prompt,
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
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    return { kind: "upstream_unavailable" };
  }
  if (result.kind === "invalid_response") {
    logger.warn("Classifier returned an unparsable response", {
      event: "classifier.invalid_response",
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    return { kind: "invalid_response" };
  }

  const decision = targetClassificationDecisionSchema.safeParse(result.output);
  if (!decision.success) {
    logger.warn("Classifier decision failed schema validation", {
      event: "classifier.invalid_decision",
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    return { kind: "invalid_response" };
  }
  return { kind: "completed", classification: decision.data };
}
