/**
 * Shared handler for the internal "normalized automation event" endpoints
 * (e.g. `/internal/github-event`, `/internal/slack-event`). Each bot
 * pre-normalizes its source's events and POSTs them here; this layer
 * authenticates, validates the event envelope, and forwards to the singleton
 * SchedulerDO for matching and dispatch. The only per-source difference is the
 * required-field check, supplied via `validate`.
 */

import type { AutomationEventSource } from "@open-inspect/shared";
import { verifyInternalToken } from "../auth/internal";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

export function createAutomationEventRoute(opts: {
  path: string;
  source: AutomationEventSource;
  /** Validate source-specific required fields. Returns an error message, or null when valid. */
  validate: (event: Record<string, unknown>) => string | null;
}): Route {
  async function handler(
    request: Request,
    env: Env,
    _match: RegExpMatchArray,
    _ctx: RequestContext
  ): Promise<Response> {
    // 0. Authenticate — fail closed if secret is unconfigured or token is invalid.
    //    The router-level gate already enforces this; repeat it here for
    //    defense-in-depth.
    if (!env.INTERNAL_CALLBACK_SECRET) {
      return error("Internal authentication not configured", 500);
    }
    const isValid = await verifyInternalToken(
      request.headers.get("Authorization"),
      env.INTERNAL_CALLBACK_SECRET
    );
    if (!isValid) {
      return error("Unauthorized", 401);
    }

    // 1. Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error("Invalid JSON", 400);
    }

    // 2. Validate envelope — source, then source-specific fields, then the
    //    common dispatch keys every event must carry.
    const event = body as Record<string, unknown>;
    if (event.source !== opts.source) {
      return error(`Invalid event: source must be '${opts.source}'`, 400);
    }
    const fieldError = opts.validate(event);
    if (fieldError) {
      return error(fieldError, 400);
    }
    if (!event.eventType || !event.triggerKey || !event.concurrencyKey) {
      return error("Invalid event: eventType, triggerKey, and concurrencyKey are required", 400);
    }

    // 3. Forward to SchedulerDO
    if (!env.SCHEDULER) {
      return error("Scheduler not configured", 503);
    }
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName("global-scheduler"));

    let response: Response;
    try {
      response = await stub.fetch("http://internal/internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch {
      return json({ ok: false, error: "Failed to reach scheduler" }, 502);
    }

    let result: { triggered: number; skipped: number };
    try {
      result = await response.json<{ triggered: number; skipped: number }>();
    } catch {
      return json({ ok: false, error: "Invalid response from scheduler" }, 502);
    }

    return json({ ok: true, ...result }, response.status);
  }

  return { method: "POST", pattern: parsePattern(opts.path), handler };
}
