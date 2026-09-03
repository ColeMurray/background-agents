/**
 * Automation pause, resume, and manual trigger routes.
 */

import { nextCronOccurrence } from "@open-inspect/shared/cron";
import { AutomationStore } from "../db/automation-store";
import { UserStore } from "../db/user-store";
import {
  AutomationExecutionUnauthorizedError,
  AutomationTriggerBlockedError,
  Scheduler,
} from "../scheduler/scheduler";
import { hydrateAutomation } from "../automation/hydrate";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  error,
  requireAutomation,
} from "./shared";
import type { Env } from "../types";
import { resolveGitHubCredentialAuthority } from "../source-control/github-credential-authority";
import { resolveGitHubEnrichmentForRequest } from "../session/identity";
import { createLogger } from "../logger";
import { AUTOMATION_MANAGE, admittedAutomation } from "./automation-shared";

const logger = createLogger("router:automations");

async function handlePauseAutomation(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new AutomationStore(ctx.db);
  admittedAutomation(ctx);
  const result = await ctx.db.batch([store.bindPause(id)]);
  const paused = result[0]?.meta.changes === 1;
  if (!paused) return error("Automation not found", 404);

  logger.info("automation.paused", {
    event: "automation.paused",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const row = await store.getById(id);
  return json({
    automation: row ? await hydrateAutomation(ctx.db, row) : null,
  });
}

async function handleResumeAutomation(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new AutomationStore(ctx.db);
  const { automation: existing } = admittedAutomation(ctx);

  // For schedule automations, compute the next run time.
  // For event-driven automations, resume with null next_run_at.
  let nextRunAt: number | null;
  if (existing.trigger_type === "schedule") {
    if (!existing.schedule_cron) {
      return error("Cannot resume: automation has no cron schedule", 400);
    }
    nextRunAt = nextCronOccurrence(existing.schedule_cron, existing.schedule_tz).getTime();
  } else {
    nextRunAt = null;
  }

  const result = await ctx.db.batch([store.bindResume(id, nextRunAt)]);
  const resumed = result[0]?.meta.changes === 1;
  if (!resumed) return error("Automation not found", 404);

  logger.info("automation.resumed", {
    event: "automation.resumed",
    automation_id: id,
    next_run_at: nextRunAt,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const row = await store.getById(id);
  return json({
    automation: row ? await hydrateAutomation(ctx.db, row) : null,
  });
}

async function handleTriggerAutomation(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  admittedAutomation(ctx);
  const requesterUserId = ctx.authorization?.userId;
  if (!requesterUserId) return error("Authorization unavailable", 503);

  let requesterEnrichment;
  try {
    requesterEnrichment = await resolveGitHubEnrichmentForRequest(
      env,
      ctx.db,
      new UserStore(ctx.db),
      requesterUserId,
      await resolveGitHubCredentialAuthority(ctx, request.headers)
    );
  } catch (enrichmentError) {
    logger.warn("Failed to enrich manual automation trigger with GitHub identity", {
      error:
        enrichmentError instanceof Error ? enrichmentError : new Error(String(enrichmentError)),
      automation_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }

  // The scheduler performs the authoritative D1-backed concurrency check.
  let triggerResult;
  try {
    triggerResult = await new Scheduler(ctx.db, env, ctx.executionCtx).trigger(
      id,
      requesterUserId,
      requesterEnrichment ?? undefined
    );
  } catch (triggerError) {
    logger.error("automation.trigger_failed", {
      event: "automation.trigger_failed",
      automation_id: id,
      error: triggerError instanceof Error ? triggerError : new Error(String(triggerError)),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    if (triggerError instanceof AutomationTriggerBlockedError) {
      return error("A run is already active for this automation", 409);
    }
    if (triggerError instanceof AutomationExecutionUnauthorizedError) {
      return json({ error: "Execution authorization required" }, 403);
    }
    return error("Failed to trigger automation", 500);
  }

  logger.info("automation.triggered", {
    event: "automation.triggered",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ invocationId: triggerResult.invocationId, runs: triggerResult.runs }, 201);
}

export const automationLifecycleRoutes = new Hono<ControlPlaneHonoEnv>();

automationLifecycleRoutes.post("/automations/:id/pause", AUTOMATION_MANAGE, (c) =>
  dispatch(c, handlePauseAutomation)
);
automationLifecycleRoutes.post("/automations/:id/resume", AUTOMATION_MANAGE, (c) =>
  dispatch(c, handleResumeAutomation)
);
automationLifecycleRoutes.post(
  "/automations/:id/trigger",
  admit({ ...GITHUB_USER_OR_SERVICE_ROUTE, authorization: requireAutomation("trigger") }),
  (c) => dispatch(c, handleTriggerAutomation)
);
