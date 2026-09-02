/**
 * Shared handling for the internal "normalized automation event" endpoints
 * (e.g. `/internal/github-event`, `/internal/slack-event`). Each bot
 * pre-normalizes its source's events and POSTs them here; this layer
 * authenticates, validates the event envelope, and invokes the scheduler for
 * matching and dispatch. Sources with no extra behavior use
 * `createAutomationEventRoute`; sources that piggyback additional processing
 * (github's PR lifecycle tracking) compose the exported steps in their own
 * named handler.
 */

import {
  automationEventSchema,
  type AutomationEvent,
  type AutomationEventSource,
} from "@open-inspect/shared/triggers";
import { createLogger } from "../logger";
import type { Route, RequestContext } from "../routes/shared";
import {
  defineRoute,
  error,
  GITHUB_SERVICE_ROUTE,
  json,
  serviceAuthorized,
} from "../routes/shared";
import type { Env } from "../types";
import { Scheduler } from "../scheduler/scheduler";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function logAutomationEventRejection(
  body: unknown,
  source: AutomationEventSource,
  issuePaths: string[],
  ctx: RequestContext
): void {
  const rawEventType = isRecord(body) ? body.eventType : undefined;
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
  if (!isRecord(body)) {
    return {
      response: error("Invalid event: body must be a JSON object", 400),
      issuePaths: ["body"],
    };
  }
  if (body.source !== source) {
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

/** Process a validated event through the automation scheduler. */
export async function forwardAutomationEventToScheduler(
  env: Env,
  event: AutomationEvent,
  ctx: RequestContext
): Promise<Response> {
  let result;
  try {
    result = await new Scheduler(ctx.db, env, ctx.executionCtx).event(event);
  } catch {
    return json({ ok: false, error: "Failed to reach scheduler" }, 502);
  }

  return json({ ok: true, ...result });
}

/** Create an authenticated route for a normalized automation event source. */
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

    return forwardAutomationEventToScheduler(env, validated.event, ctx);
  }

  return defineRoute(GITHUB_SERVICE_ROUTE, {
    method: "POST",
    path: opts.path,
    authorization: serviceAuthorized("slack-bot"),
    handler,
  });
}
