/**
 * Shared handling for the internal "normalized automation event" endpoints
 * (e.g. `/internal/github-event`, `/internal/slack-event`). Each bot
 * pre-normalizes its source's events and POSTs them here; this layer
 * authenticates, validates the event envelope, and forwards to the singleton
 * SchedulerDO for matching and dispatch. Sources with no extra behavior use
 * `createAutomationEventRoute`; sources that piggyback additional processing
 * (github's PR lifecycle tracking) compose the exported steps in their own
 * named handler.
 */

import {
  automationEventSchema,
  type AutomationEvent,
  type AutomationEventSource,
} from "@open-inspect/shared/triggers";
import { requireEventPoster } from "../auth/identity-enforcement";
import type { Route, RequestContext } from "../routes/shared";
import { parsePattern, json, error } from "../routes/shared";
import type { Env } from "../types";

type AutomationEventForSource<S extends AutomationEventSource> = Extract<
  AutomationEvent,
  { source: S }
>;

export type AutomationEventEnvelopeResult<S extends AutomationEventSource> =
  | { event: AutomationEventForSource<S>; response?: never }
  | { event?: never; response: Response };

/**
 * Validate the source and the complete normalized event protocol.
 */
export function validateAutomationEventEnvelope<S extends AutomationEventSource>(
  body: unknown,
  source: S
): AutomationEventEnvelopeResult<S> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { response: error("Invalid event: body must be a JSON object", 400) };
  }
  if ((body as Record<string, unknown>).source !== source) {
    return { response: error(`Invalid event: source must be '${source}'`, 400) };
  }

  const parsed = automationEventSchema.safeParse(body);
  if (!parsed.success) {
    const invalidFields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body")),
    ].join(", ");
    return { response: error(`Invalid event: ${invalidFields}`, 400) };
  }

  // The source equality check above narrows the discriminated union at runtime.
  return { event: parsed.data as AutomationEventForSource<S> };
}

/** Forward a validated event to the singleton SchedulerDO for matching. */
export async function forwardAutomationEventToScheduler(
  env: Env,
  event: AutomationEvent
): Promise<Response> {
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

  let result: { triggered: number; skipped: number; steered?: number };
  try {
    result = await response.json<{ triggered: number; skipped: number; steered?: number }>();
  } catch {
    return json({ ok: false, error: "Invalid response from scheduler" }, 502);
  }

  return json({ ok: true, ...result }, response.status);
}

export function createAutomationEventRoute(opts: {
  path: string;
  source: AutomationEventSource;
}): Route {
  async function handler(
    request: Request,
    env: Env,
    _match: RegExpMatchArray,
    ctx: RequestContext
  ): Promise<Response> {
    const authFailure = requireEventPoster(ctx, opts.source);
    if (authFailure) return authFailure;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error("Invalid JSON", 400);
    }

    const validated = validateAutomationEventEnvelope(body, opts.source);
    if (validated.response) return validated.response;

    return forwardAutomationEventToScheduler(env, validated.event);
  }

  return { method: "POST", pattern: parsePattern(opts.path), handler };
}
