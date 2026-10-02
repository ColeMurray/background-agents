import { Hono } from "hono";
import { z } from "zod";
import { isCanonicalUserId } from "@open-inspect/shared";
import { AutomationStore } from "../db/automation-store";
import { TeamAuditStore } from "../db/team-audit";
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

async function changeExecutor(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { automation, viewer } = admittedAutomation(ctx);
  if (
    viewer.kind !== "user" ||
    (viewer.roleKey !== "owner" &&
      viewer.roleKey !== "administrator" &&
      (automation.owner_team_id === null ||
        viewer.memberships.get(automation.owner_team_id) !== "lead"))
  ) {
    return json(
      {
        error: "Team lead or administrator required",
        code: "automation_action_denied",
        reason_code: "not_owner_or_lead",
      },
      403
    );
  }
  const body = await parseBody(request, executorBodySchema, "Invalid executor");
  if (body instanceof Response) return body;
  const executorError = await validateAutomationExecutor(ctx.db, body.userId);
  if (executorError) return executorError;
  const teamError = await validateAutomationTeam(ctx.db, automation.owner_team_id, body.userId);
  if (teamError) return teamError;
  const store = new AutomationStore(ctx.db);
  const [repositories, environments] = await Promise.all([
    store.getRepositoriesForAutomation(params.id),
    store.getEnvironmentsForAutomation(params.id),
  ]);
  const executorUnauthorized = () =>
    json(
      {
        error: "Executor cannot launch this automation",
        code: "automation_executor_unauthorized",
        reason_code: "execution_authorization_denied",
      },
      403
    );
  if (
    !(await isAutomationExecutionAuthorized(ctx.db, {
      automationId: params.id,
      executionUserId: body.userId,
      requiresRepositoryUse: repositories.length > 0,
      requiresEnvironmentUse: environments.length > 0,
    }))
  ) {
    return executorUnauthorized();
  }
  if (automation.user_id === body.userId) {
    return json({ automation: await hydrateAutomationResponse(ctx, automation, viewer) });
  }
  const results = await ctx.db.batch([
    store.bindExecutorChange(automation, body.userId, viewer.userId),
    new TeamAuditStore(ctx.db).bind(
      {
        requestId: ctx.request_id,
        actorUserId: viewer.userId,
        action: "automation.executor_changed",
        resourceType: "automation",
        resourceId: params.id,
        teamId: automation.owner_team_id,
        targetUserId: body.userId,
        before: { userId: automation.user_id },
        after: { userId: body.userId },
      },
      true
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const executorError = await validateAutomationExecutor(ctx.db, body.userId);
    if (executorError) return executorError;
    const teamError = await validateAutomationTeam(ctx.db, automation.owner_team_id, body.userId);
    if (teamError) return teamError;
    if (
      !(await isAutomationExecutionAuthorized(ctx.db, {
        automationId: params.id,
        executionUserId: body.userId,
        requiresRepositoryUse: "stored",
        requiresEnvironmentUse: "stored",
      }))
    ) {
      return executorUnauthorized();
    }
    // Otherwise the row or the caller's reassignment authority changed after admission.
    return json({ error: "Automation changed concurrently", code: "automation_conflict" }, 409);
  }
  const updated = await store.getById(params.id);
  if (!updated) return error("Automation not found", 404);
  return json({ automation: await hydrateAutomationResponse(ctx, updated, viewer) });
}

export const automationExecutorRoutes = new Hono<ControlPlaneHonoEnv>();
automationExecutorRoutes.patch("/automations/:id", AUTOMATION_MANAGE, (c) =>
  dispatch(c, changeExecutor)
);
