import { targetClassificationRequestSchema } from "@open-inspect/shared/types/target-classification";
import {
  createTargetClassification,
  InvalidTargetClassificationResponseError,
  OpenAIOAuthNotConfiguredError,
  OpenAIOAuthUnavailableError,
  TargetClassifierUpstreamUnavailableError,
} from "../target-classifications/service";
import type { Env } from "../types";
import {
  error,
  json,
  parseJsonBody,
  parsePattern,
  type RequestContext,
  type Route,
} from "./shared";

export async function handleCreateTargetClassification(
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

  const parsedRequest = targetClassificationRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) return error("Invalid target classification request", 400);

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("OpenAI OAuth is not configured", 503);
  }

  try {
    const classification = await createTargetClassification(parsedRequest.data, {
      db: ctx.db,
      encryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    });
    return json(classification);
  } catch (caught) {
    if (caught instanceof OpenAIOAuthNotConfiguredError) {
      return error("OpenAI OAuth is not configured", 503);
    }
    if (caught instanceof OpenAIOAuthUnavailableError) {
      return error("OpenAI OAuth unavailable", 502);
    }
    if (caught instanceof TargetClassifierUpstreamUnavailableError) {
      return error("Classifier upstream unavailable", 502);
    }
    if (caught instanceof InvalidTargetClassificationResponseError) {
      return error("Classifier returned an invalid response", 502);
    }
    throw caught;
  }
}

export const targetClassificationRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/internal/target-classifications"),
    handler: handleCreateTargetClassification,
  },
];
