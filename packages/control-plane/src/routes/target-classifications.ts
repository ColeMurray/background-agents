import { targetClassificationRequestSchema } from "@open-inspect/shared/types/target-classification";
import { createTargetClassification } from "../target-classifications/service";
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

  const result = await createTargetClassification(parsedRequest.data, {
    db: ctx.db,
    encryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  });

  switch (result.kind) {
    case "completed":
      return json(result.classification);
    case "prompt_too_long":
      return error("Target classification input exceeds the prompt limit", 400);
    case "oauth_not_configured":
      return error("OpenAI OAuth is not configured", 503);
    case "oauth_unavailable":
      return error("OpenAI OAuth unavailable", 502);
    case "upstream_unavailable":
      return error("Classifier upstream unavailable", 502);
    case "invalid_response":
      return error("Classifier returned an invalid response", 502);
  }
}

export const targetClassificationRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/internal/target-classifications"),
    handler: handleCreateTargetClassification,
  },
];
