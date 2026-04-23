/**
 * Sentry webhook route — per-automation endpoint that verifies the Sentry
 * HMAC signature using the automation's stored (encrypted) client secret.
 */

import { verifySentrySignature, normalizeSentryEvent } from "@open-inspect/shared";
import { AutomationStore } from "../db/automation-store";
import { decryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

const logger = createLogger("webhook:sentry");

/** Maximum Sentry webhook payload size (256KB — Sentry payloads with stack traces can be large). */
const MAX_PAYLOAD_SIZE = 256 * 1024;

async function handleSentryWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  // 1. Look up the automation
  const store = new AutomationStore(env.DB);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "sentry") {
    return error("Not found", 404);
  }

  // 1a. Short-circuit disabled automations before expensive crypto
  if (automation.enabled !== 1) {
    logger.info("Webhook skipped: automation disabled", {
      event: "webhook.skipped",
      automation_id: automationId,
      reason: "disabled",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ ok: true, triggered: 0, skipped: 1 });
  }

  if (!automation.trigger_auth_data) {
    return error("Sentry secret not configured for this automation", 500);
  }

  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("Encryption key not configured", 503);
  }

  // 2. Check signature header before doing any expensive work (decrypt, body read)
  const signature = request.headers.get("sentry-hook-signature");
  if (!signature) {
    return error("Invalid signature", 401);
  }

  // Fast-path: reject if Content-Length header exceeds limit
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  const body = await request.text();
  if (body.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  // 3. Decrypt stored secret and verify signature
  const secret = await decryptSentrySecret(
    automation.trigger_auth_data,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );

  const valid = await verifySentrySignature(body, signature, secret);
  if (!valid) {
    logger.warn("Webhook auth failed", {
      event: "webhook.auth_failed",
      automation_id: automationId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Invalid signature", 401);
  }

  // 4. Parse and normalize
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", 400);
  }

  const event = normalizeSentryEvent(payload, automationId);
  if (!event) {
    return json({ ok: true, skipped: true });
  }

  // 5. Forward to SchedulerDO
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

  logger.info("Webhook processed", {
    event: "webhook.processed",
    automation_id: automationId,
    triggered: result.triggered,
    skipped: result.skipped,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ ok: true, ...result }, response.status === 200 ? 200 : response.status);
}

export const sentryWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry/:id"),
  handler: handleSentryWebhook,
};
