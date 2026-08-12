import {
  buildTargetClassificationPrompt,
  CLASSIFY_TARGET_TOOL_NAME,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
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

export class OpenAIOAuthNotConfiguredError extends Error {}
export class OpenAIOAuthUnavailableError extends Error {}
export class TargetClassifierUpstreamUnavailableError extends Error {}
export class InvalidTargetClassificationResponseError extends Error {}

type TargetClassificationServiceContext = {
  db: SqlDatabase;
  encryptionKey: string;
  requestId: string;
  traceId: string;
};

export async function createTargetClassification(
  request: TargetClassificationRequest,
  context: TargetClassificationServiceContext
): Promise<TargetClassificationDecision> {
  const broker = new OpenAITokenBroker(context.db, context.encryptionKey, logger);
  const tokenResult = await broker.refreshGlobal();
  if (!tokenResult.ok) {
    if (tokenResult.status === 404) throw new OpenAIOAuthNotConfiguredError();
    throw new OpenAIOAuthUnavailableError();
  }

  const result = await requestOpenAICodexFunction({
    accessToken: tokenResult.accessToken,
    accountId: tokenResult.accountId,
    requestId: context.requestId,
    traceId: context.traceId,
    model: OPENAI_MODEL,
    systemPrompt: TARGET_CLASSIFIER_SYSTEM_PROMPT,
    prompt: buildTargetClassificationPrompt(request),
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
    throw new TargetClassifierUpstreamUnavailableError();
  }
  if (result.kind === "invalid_response") {
    logger.warn("Classifier returned an unparsable response", {
      event: "classifier.invalid_response",
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    throw new InvalidTargetClassificationResponseError();
  }

  const decision = targetClassificationDecisionSchema.safeParse(result.output);
  if (!decision.success) {
    logger.warn("Classifier decision failed schema validation", {
      event: "classifier.invalid_decision",
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    throw new InvalidTargetClassificationResponseError();
  }

  const catalogIds = new Set(request.targets.map((target) => target.id));
  const referencesUnknownTarget =
    (decision.data.targetId !== null && !catalogIds.has(decision.data.targetId)) ||
    decision.data.alternatives.some((targetId) => !catalogIds.has(targetId));
  if (referencesUnknownTarget) {
    logger.warn("Classifier decision referenced a target outside the catalog", {
      event: "classifier.invalid_decision",
      request_id: context.requestId,
      trace_id: context.traceId,
    });
    throw new InvalidTargetClassificationResponseError();
  }

  return decision.data;
}
