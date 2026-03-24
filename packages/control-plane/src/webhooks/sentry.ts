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

  // 2. Decrypt the stored secret and verify signature
  const secret = await decryptSentrySecret(
    automation.trigger_auth_data,
    env.REPO_SECRETS_ENCRYPTION_KEY
  );

  // Fast-path: reject if Content-Length header exceeds limit
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

  const signature = request.headers.get("sentry-hook-signature");
  const body = await request.text();
  if (body.length > MAX_PAYLOAD_SIZE) {
    return error("Payload too large", 413);
  }

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

export const sentryWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry/:id"),
  handler: handleSentryWebhook,
};
