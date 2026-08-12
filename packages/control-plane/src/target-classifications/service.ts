import {
  buildTargetClassificationPrompt,
  CLASSIFY_TARGET_TOOL_NAME,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
  type TargetClassificationDecision,
  type TargetClassificationRequest,
} from "@open-inspect/shared/types/target-classification";
import {
  OpenAITokenBroker,
  OpenAITokenBrokerError,
  OpenAITokenNotConfiguredError,
  type OpenAIToken,
} from "../auth/openai-token-broker";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { requestOpenAICodexFunction } from "../openai/codex-responses";
import { InvalidOpenAICodexResponseError, OpenAICodexUpstreamError } from "../openai/codex-errors";

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
  let token: OpenAIToken;
  try {
    token = await broker.refreshGlobal();
  } catch (error) {
    if (error instanceof OpenAITokenNotConfiguredError) throw new OpenAIOAuthNotConfiguredError();
    if (error instanceof OpenAITokenBrokerError) throw new OpenAIOAuthUnavailableError();
    throw error;
  }

  let output: unknown;
  try {
    output = await requestOpenAICodexFunction({
      accessToken: token.accessToken,
      accountId: token.accountId,
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
  } catch (error) {
    if (error instanceof OpenAICodexUpstreamError) {
      logger.warn("Classifier upstream unavailable", {
        event: "classifier.upstream_error",
        upstream_status: error.status,
        request_id: context.requestId,
        trace_id: context.traceId,
      });
      throw new TargetClassifierUpstreamUnavailableError();
    }
    if (error instanceof InvalidOpenAICodexResponseError) {
      logger.warn("Classifier returned an unparsable response", {
        event: "classifier.invalid_response",
        request_id: context.requestId,
        trace_id: context.traceId,
      });
      throw new InvalidTargetClassificationResponseError();
    }
    throw error;
  }

  const decision = targetClassificationDecisionSchema.safeParse(output);
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
