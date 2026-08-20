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
import { createLogger } from "../logger";
import type { Route, RequestContext } from "../routes/shared";
import {
  defineRoute,
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  parsePattern,
} from "../routes/shared";
import type { Env } from "../types";

type AutomationEventForSource<S extends AutomationEventSource> = Extract<
  AutomationEvent,
  { source: S }
>;

const logger = createLogger("webhook:automation-event");

export type AutomationEventEnvelopeResult<S extends AutomationEventSource> =
  | { event: AutomationEventForSource<S>; response?: never }
  | { event?: never; response: Response; issuePaths: string[] };

function hasAutomationEventSource<S extends AutomationEventSource>(
  event: AutomationEvent,
  source: S
): event is AutomationEventForSource<S> {
  return event.source === source;
}

export function logAutomationEventRejection(
  body: unknown,
  source: AutomationEventSource,
  issuePaths: string[],
  ctx: RequestContext
): void {
  const rawEventType =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).eventType
      : undefined;
  const eventType = typeof rawEventType === "string" ? rawEventType.slice(0, 128) : undefined;

  logger.warn("Normalized automation event rejected", {
    event: "automation_event.ingress_rejected",
    source,
    event_type: eventType,
    issue_paths: issuePaths,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

/**
 * Validate the source and the complete normalized event protocol.
 */
export function validateAutomationEventEnvelope<S extends AutomationEventSource>(
  body: unknown,
  source: S
): AutomationEventEnvelopeResult<S> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      response: error("Invalid event: body must be a JSON object", 400),
      issuePaths: ["body"],
    };
  }
  if ((body as Record<string, unknown>).source !== source) {
    return {
      response: error(`Invalid event: source must be '${source}'`, 400),
      issuePaths: ["source"],
    };
  }

  const parsed = automationEventSchema.safeParse(body);
  if (!parsed.success) {
    const issuePaths = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "body")),
    ];
    return {
      response: error(`Invalid event: ${issuePaths.join(", ")}`, 400),
      issuePaths,
    };
  }

  if (!hasAutomationEventSource(parsed.data, source)) {
    return {
      response: error(`Invalid event: source must be '${source}'`, 400),
      issuePaths: ["source"],
    };
  }
  return { event: parsed.data };
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
      logAutomationEventRejection(undefined, opts.source, ["body"], ctx);
      return error("Invalid JSON", 400);
    }

    const validated = validateAutomationEventEnvelope(body, opts.source);
    if (validated.response) {
      logAutomationEventRejection(body, opts.source, validated.issuePaths, ctx);
      return validated.response;
    }

    return forwardAutomationEventToScheduler(env, validated.event);
  }

  return defineRoute(GITHUB_USER_OR_SERVICE_ROUTE, {
    method: "POST",
    pattern: parsePattern(opts.path),
    handler,
  });
}
