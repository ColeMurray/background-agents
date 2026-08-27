/**
 * Sentry webhook route — per-automation endpoint that verifies the Sentry
 * HMAC signature using the automation's stored (encrypted) client secret.
 */

import { verifySentrySignature, normalizeSentryEvent } from "@open-inspect/shared/triggers";
import { AutomationStore } from "../db/automation-store";
import { decryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
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

/** Maximum Sentry webhook payload size (256KB — Sentry payloads with stack traces can be large). */
const MAX_PAYLOAD_SIZE = 256 * 1024;
const logger = createLogger("sentry-webhook");

function classifySentryAction(action: unknown): "created" | "critical" | "other" | "missing" {
  if (action === "created" || action === "critical") return action;
  return typeof action === "string" ? "other" : "missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function handleSentryWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  // 1. Look up the automation
  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation || automation.trigger_type !== "sentry") {
    return error("Not found", 404);
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
    return error("Invalid signature", 401);
  }

  // 3. Parse and normalize
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(body) as unknown;
  } catch {
    return error("Invalid JSON", 400);
  }
  const payload = isRecord(parsedPayload) ? parsedPayload : {};

  const sentryResource = request.headers.get("sentry-hook-resource");
  const normalization = normalizeSentryEvent(payload, automationId, sentryResource);
  if (normalization.status === "skipped") {
    const logData = {
      event: "sentry.webhook_skipped",
      reason: normalization.reason,
      automation_id: automationId,
      configured_event_type: automation.event_type,
      sentry_resource: sentryResource,
      sentry_action: classifySentryAction(payload.action),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    };
    if (normalization.reason === "unsupported_action") {
      logger.info("Sentry webhook action is not configured for automation", logData);
    } else {
      logger.warn("Sentry webhook skipped during normalization", logData);
    }
    return json({ ok: true, skipped: true });
  }
  const event = normalization.event;

  // 4. Process the event.
  const result = await new Scheduler(ctx.db, env, ctx.executionCtx).event(event);
  return json({ ok: true, ...result });
}

export const sentryWebhookRoute: Route = defineRoute(SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry/:id"),
  handler: handleSentryWebhook,
});
