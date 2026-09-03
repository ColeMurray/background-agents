/**
 * Slack automation event webhook route — internal endpoint that receives
 * pre-normalized SlackAutomationEvents from the slack-bot and proxies them
 * to the scheduler for automation matching and session dispatch.
 *
 * The slack-bot is responsible for ingress filtering (watched channels,
 * mention suppression) and normalization; this endpoint only authenticates,
 * validates the event envelope, and forwards. Channel-keyed candidate
 * selection, condition evaluation, and dedup all happen in the scheduler.
 */

import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { RequestContext } from "../routes/shared";
import { error, GITHUB_SERVICE_ROUTE, serviceAuthorized } from "../routes/shared";
import type { Env } from "../types";
import {
  forwardAutomationEventToScheduler,
  logAutomationEventRejection,
  validateAutomationEventEnvelope,
} from "./automation-event";

async function handleSlackAutomationEvent(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logAutomationEventRejection(undefined, "slack", ["body"], ctx);
    return error("Invalid JSON", 400);
  }

  const validated = validateAutomationEventEnvelope(body, "slack");
  if (validated.response) {
    logAutomationEventRejection(body, "slack", validated.issuePaths, ctx);
    return validated.response;
  }

  return forwardAutomationEventToScheduler(env, validated.event, ctx);
}

export const slackAutomationEventRoutes = new Hono<ControlPlaneHonoEnv>();

slackAutomationEventRoutes.post(
  "/internal/slack-event",
  admit({ ...GITHUB_SERVICE_ROUTE, authorization: serviceAuthorized("slack-bot") }),
  (c) => handleSlackAutomationEvent(c.var.admitted.request, c.env, c.var.admitted.ctx)
);
