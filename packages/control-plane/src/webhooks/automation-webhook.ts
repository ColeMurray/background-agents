/**
 * Generic automation webhook route — per-automation inbound HTTP endpoint.
 */

import { normalizeWebhookEvent } from "@open-inspect/shared";
import { AutomationStore } from "../db/automation-store";
import { verifyWebhookApiKey } from "../auth/webhook-key";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

/** Maximum webhook payload size (64KB). */
const MAX_PAYLOAD_SIZE = 64 * 1024;

async function handleAutomationWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
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
  const store = new AutomationStore(env.DB);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "webhook") {
    return error("Not found", 404);
  }

  if (!automation.webhook_secret_hash) {
    return error("Webhook not configured", 500);
  }

  // 4. Verify API key
  const valid = await verifyWebhookApiKey(apiKey, automation.webhook_secret_hash);
  if (!valid) return error("Invalid API key", 401);

  // 5. Parse body
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

  const idempotencyKey =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).idempotencyKey as string | undefined)
      : undefined;

  // 6. Normalize and forward to SchedulerDO
  const event = normalizeWebhookEvent(automationId, body, idempotencyKey);

  if (!env.SCHEDULER) {
    return error("Scheduler not configured", 503);
  }

  const doId = env.SCHEDULER.idFromName("global-scheduler");
  const stub = env.SCHEDULER.get(doId);

  const response = await stub.fetch("http://internal/internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  const result = await response.json<{ triggered: number; skipped: number }>();
  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const automationWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/automation/:id"),
  handler: handleAutomationWebhook,
};
