import { Hono } from "hono";
import { z } from "zod";
import { SessionInternalPaths } from "../session/contracts";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import {
  permissionRequirement,
  requireAll,
  requireSession,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  sessionRequirement,
} from "./shared";

const decisionSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().min(1).max(1_000).optional(),
});

interface ExternalActionParams {
  id: string;
  actionId: string;
}

export async function handleExternalActionStatus(
  _request: Request,
  _env: Env,
  params: ExternalActionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  return ctx.sessionRuntime.fetch(
    params.id,
    SessionInternalPaths.externalActionStatus,
    undefined,
    `?actionId=${encodeURIComponent(params.actionId)}`
  );
}

export async function handleExternalActionDecision(
  request: Request,
  _env: Env,
  params: ExternalActionParams,
  ctx: SessionRouteContext
): Promise<Response> {
  const body = await parseBody(request, decisionSchema, "Invalid external action decision");
  if (body instanceof Response) return body;
  const actorId = ctx.authorization?.userId;
  if (!actorId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.externalActionDecision, {
    method: "POST",
    headers: { "X-External-Action-Actor-ID": actorId },
    body: JSON.stringify({ actionId: params.actionId, ...body }),
  });
}

export async function handleExternalActionPending(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  return ctx.sessionRuntime.fetch(
    params.id,
    SessionInternalPaths.externalActionPending,
    undefined,
    new URL(request.url).search
  );
}

export const sessionExternalActionRoutes = new Hono<ControlPlaneHonoEnv>();
sessionExternalActionRoutes.get(
  "/sessions/:id/external-actions",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") }),
  (c) => dispatchSession(c, handleExternalActionPending)
);
sessionExternalActionRoutes.get(
  "/sessions/:id/external-actions/:actionId",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") }),
  (c) => dispatchSession(c, handleExternalActionStatus)
);
sessionExternalActionRoutes.post(
  "/sessions/:id/external-actions/:actionId/decision",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireAll(
      // Deciding an external effect is an action, not a read. A private
      // break-glass reader and a workspace administrator without current
      // owning-team membership must not be able to approve a publication.
      sessionRequirement("collaborate"),
      permissionRequirement("external_actions.approve")
    ),
  }),
  (c) => dispatchSession(c, handleExternalActionDecision)
);
