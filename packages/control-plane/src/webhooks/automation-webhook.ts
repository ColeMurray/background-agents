/**
 * Generic automation webhook route — per-automation inbound HTTP endpoint.
 */

import { normalizeWebhookEvent } from "@open-inspect/shared/triggers";
import { AutomationStore } from "../db/automation-store";
import { verifyWebhookApiKey } from "../auth/webhook-key";
import type { Route, RequestContext } from "../routes/shared";
import {
  defineRoute,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
} from "../routes/shared";
import type { Env } from "../types";
import { Scheduler } from "../scheduler/scheduler";

/** Maximum webhook payload size (64KB). */
const MAX_PAYLOAD_SIZE = 64 * 1024;

export function parseWebhookIdempotencyKey(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("idempotencyKey" in body)) {
    return undefined;
  }

  return typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
}

async function handleAutomationWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  // 1. Validate content type
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }

  // 2. Validate API key
  const authHeader = request.headers.get("authorization");
  const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!apiKey) return error("Missing API key", 401);

  // 3. Look up automation
  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "webhook") {
    return error("Not found", 404);
  }

  if (!automation.trigger_auth_data) {
    return error("Webhook not configured", 500);
  }

  // 4. Verify API key
  const valid = await verifyWebhookApiKey(apiKey, automation.trigger_auth_data);
  if (!valid) return error("Invalid API key", 401);

  // 5. Parse body — fast-path reject on Content-Length before reading
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }
  const bodyText = await request.text();
  if (bodyText.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return error("Invalid JSON body", 400);
  }

  const idempotencyKey = parseWebhookIdempotencyKey(body);

  // 6. Normalize and process the event.
  const event = normalizeWebhookEvent(automationId, body, idempotencyKey);
  const response = await new Scheduler(ctx.db, env, ctx.executionCtx).event(event);

  const result = await response.json<{ triggered: number; skipped: number }>();
  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const automationWebhookRoute: Route = defineRoute(SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, {
  method: "POST",
  pattern: parsePattern("/webhooks/automation/:id"),
  handler: handleAutomationWebhook,
});
