/**
 * Sentry webhook route — per-automation endpoint that verifies the Sentry
 * HMAC signature using the automation's stored (encrypted) client secret.
 */

import { verifySentrySignature, normalizeSentryEvent } from "@open-inspect/shared";
import { AutomationStore } from "../db/automation-store";
import { decryptSentrySecret } from "../auth/webhook-key";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";
import { forwardAutomationEventToScheduler } from "./automation-event";

/** Maximum Sentry webhook payload size (256KB — Sentry payloads with stack traces can be large). */
const MAX_PAYLOAD_SIZE = 256 * 1024;

async function handleSentryWebhook(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  // 1. Look up the automation
  const store = new AutomationStore(env.DB);
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

  // 4. Forward to SchedulerDO
  return forwardAutomationEventToScheduler(
    env,
    event,
    request.headers.get("x-trace-id") ?? undefined
  );
}

export const sentryWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry/:id"),
  handler: handleSentryWebhook,
};
