import { Hono } from "hono";
import { z } from "zod";
import { checkAutomationExecutorReassignment, isCanonicalUserId } from "@open-inspect/shared";
import { AutomationStore, type AutomationRow } from "../db/automation-store";
import { bindAppliedAuditEvent } from "../db/team-audit";
import { automationActionDeniedBody } from "../authorization/owned-resource-admission";
import { isAutomationExecutionAuthorized } from "../automation/authorization-guard";
import { dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { error, json, type RequestContext } from "./shared";
import {
  AUTOMATION_MANAGE,
  admittedAutomation,
  hydrateAutomationResponse,
} from "./automation-shared";
import { validateAutomationExecutor, validateAutomationTeam } from "./automation-validation";

const executorBodySchema = z.strictObject({
  userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
});

/**
 * Whether the candidate may execute this automation: an active user, a member of its active
 * team, and able to launch its stored targets. Null when they may.
 */
async function validateExecutorCandidate(
  ctx: RequestContext,
  automation: AutomationRow,
  userId: string
): Promise<Response | null> {
  const executorError = await validateAutomationExecutor(ctx.db, userId);
  if (executorError) return executorError;
  const teamError = await validateAutomationTeam(ctx, automation.owner_team_id, userId);
  if (teamError) return teamError;
  const authorized = await isAutomationExecutionAuthorized(ctx.db, {
    automationId: automation.id,
    executionUserId: userId,
    requiresRepositoryUse: "stored",
    requiresEnvironmentUse: "stored",
  });
  if (authorized) return null;
  return json(
    {
      error: "Executor cannot launch this automation",
      code: "automation_executor_unauthorized",
      reason_code: "execution_authorization_denied",
    },
    403
  );
}

async function changeExecutor(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { automation, viewer } = admittedAutomation(ctx);
  const access = checkAutomationExecutorReassignment(viewer, {
    ownerTeamId: automation.owner_team_id,
    executorUserId: automation.user_id,
  });
  if (viewer.kind !== "user" || !access.allowed) {
    const reason = access.allowed ? "missing_permission" : access.reason;
    return json(automationActionDeniedBody(reason, "Team lead or administrator required"), 403);
  }
  const body = await parseBody(request, executorBodySchema, "Invalid executor");
  if (body instanceof Response) return body;
  const candidateError = await validateExecutorCandidate(ctx, automation, body.userId);
  if (candidateError) return candidateError;
  if (automation.user_id === body.userId) {
    return json({ automation: await hydrateAutomationResponse(ctx, automation, viewer) });
  }
  const store = new AutomationStore(ctx.db);
  const results = await ctx.db.batch([
    store.bindExecutorChange(automation, body.userId, viewer.userId),
    bindAppliedAuditEvent(
      ctx.db,
      {
        requestId: ctx.request_id,
        actorUserId: viewer.userId,
        action: "automation.executor_changed",
        resourceType: "automation",
        resourceId: automation.id,
        teamId: automation.owner_team_id,
        targetUserId: body.userId,
        before: { userId: automation.user_id },
        after: { userId: body.userId },
      },
      true
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // The guarded write re-checks everything above; report a candidate that stopped qualifying,
    // otherwise the row or the caller's reassignment authority changed after admission.
    return (
      (await validateExecutorCandidate(ctx, automation, body.userId)) ??
      json({ error: "Automation changed concurrently", code: "automation_conflict" }, 409)
    );
  }
  const updated = await store.getById(params.id);
  if (!updated) return error("Automation not found", 404);
  return json({ automation: await hydrateAutomationResponse(ctx, updated, viewer) });
}

export const automationExecutorRoutes = new Hono<ControlPlaneHonoEnv>();
automationExecutorRoutes.patch("/automations/:id", AUTOMATION_MANAGE, (c) =>
  dispatch(c, changeExecutor)
);
