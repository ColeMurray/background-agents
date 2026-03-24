/**
 * Sentry webhook route — receives Sentry webhook events and forwards to SchedulerDO.
 */

import { verifySentrySignature, normalizeSentryEvent } from "@open-inspect/shared";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

async function handleSentryWebhook(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.SENTRY_WEBHOOK_SECRET) {
    return error("Sentry webhook not configured", 503);
  }

  // 1. Verify signature
  const signature = request.headers.get("sentry-hook-signature");
  const body = await request.text();

  const valid = await verifySentrySignature(body, signature, env.SENTRY_WEBHOOK_SECRET);
  if (!valid) {
    return error("Invalid signature", 401);
  }

  // 2. Parse and normalize
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return error("Invalid JSON", 400);
  }

  const event = normalizeSentryEvent(payload);
  if (!event) {
    return json({ ok: true, skipped: true });
  }

  // 3. Forward to SchedulerDO
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

  const result = await response.json();
  return json({ ok: true, ...(result as Record<string, unknown>) });
}

export const sentryWebhookRoute: Route = {
  method: "POST",
  pattern: parsePattern("/webhooks/sentry"),
  handler: handleSentryWebhook,
};
