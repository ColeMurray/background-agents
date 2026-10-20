/**
 * Automation external-action grants.
 *
 * A grant lets one automation publish one external effect unattended. It is
 * deliberately narrow: it names one provider, one action, one executor, and
 * one automation, and it stops working the moment its owner or executor loses
 * standing. Nothing here ever carries a credential.
 */

import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { AutomationExternalActionGrantStore } from "../db/automation-external-action-grants";
import { admittedAutomation, AUTOMATION_MANAGE_POLICY } from "./automation-shared";
import { GITHUB_USER_OR_SERVICE_ROUTE, error, json, type RequestContext } from "./shared";
import { createLogger } from "../logger";

const logger = createLogger("router:automations");

const createGrantBodySchema = z.object({
  provider: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
});

/**
 * Grant administration requires both the automation's own manage authority
 * and the workspace permission that governs external effects. A user who may
 * edit the automation but holds no external-action permission cannot widen
 * what that automation publishes.
 */
const AUTOMATION_GRANT_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: {
    kind: "active-user",
    allOf: [
      { kind: "automation", operation: "manage", automationIdParam: "id" },
      { kind: "permission", permission: "external_actions.manage_grants" },
    ],
    auditAllowed: true,
    service: { kind: "deny" },
  },
});

async function handleListGrants(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { automation } = admittedAutomation(ctx);
  const grants = await new AutomationExternalActionGrantStore(ctx.db).listByAutomation(
    automation.id
  );
  return json({ grants });
}

async function handleCreateGrant(
  request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { automation } = admittedAutomation(ctx);
  const body = await parseBody(request, createGrantBodySchema, "provider and action are required");
  if (body instanceof Response) return body;
  const createdBy = ctx.principal?.kind === "user" ? ctx.principal.userId : null;
  if (!createdBy) return error("Unauthorized", 401);
  // A grant always runs as the automation's own executor. An automation with
  // no executor user cannot hold an unattended grant at all.
  const executorUserId = automation.user_id;
  if (!executorUserId) {
    return error("The automation has no executor that can hold external-action grants", 409);
  }
  const store = new AutomationExternalActionGrantStore(ctx.db);
  const grant = {
    id: crypto.randomUUID(),
    automationId: automation.id,
    executorUserId,
    provider: body.provider,
    action: body.action,
    createdBy,
    createdAt: Date.now(),
  };
  const created = await store.create(grant);
  if (!created) {
    return error("The automation or its executor can no longer hold external-action grants", 409);
  }
  logger.info("automation.external_action_grant_created", {
    event: "automation.external_action_grant_created",
    automation_id: automation.id,
    provider: grant.provider,
    action: grant.action,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ grant }, 201);
}

async function handleRevokeGrant(
  _request: Request,
  _env: Env,
  params: { id: string; grantId: string },
  ctx: RequestContext
): Promise<Response> {
  const { automation } = admittedAutomation(ctx);
  const revoked = await new AutomationExternalActionGrantStore(ctx.db).revoke(
    params.grantId,
    Date.now(),
    "Revoked by an administrator",
    automation.id
  );
  if (!revoked) return error("Grant not found", 404);
  logger.info("automation.external_action_grant_revoked", {
    event: "automation.external_action_grant_revoked",
    automation_id: automation.id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ ok: true });
}

export const automationExternalActionGrantRoutes = new Hono<ControlPlaneHonoEnv>();

automationExternalActionGrantRoutes.get(
  "/automations/:id/external-action-grants",
  admit(AUTOMATION_MANAGE_POLICY),
  (c) => dispatch(c, handleListGrants)
);
automationExternalActionGrantRoutes.post(
  "/automations/:id/external-action-grants",
  AUTOMATION_GRANT_MANAGE,
  (c) => dispatch(c, handleCreateGrant)
);
automationExternalActionGrantRoutes.delete(
  "/automations/:id/external-action-grants/:grantId",
  AUTOMATION_GRANT_MANAGE,
  (c) => dispatch(c, handleRevokeGrant)
);
