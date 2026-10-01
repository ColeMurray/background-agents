import { Hono } from "hono";
import { z } from "zod";
import { checkSessionAccess, type SessionAction } from "@open-inspect/shared";
import { sessionVisibilitySchema } from "@open-inspect/shared/types/teams";
import { SessionAuditStore } from "../db/session-audit";
import { TeamAuditStore } from "../db/team-audit";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import { SessionScopeStore } from "../db/session-scope-store";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamStore } from "../db/teams";
import { UserStore } from "../db/user-store";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import type { SqlStatement } from "../db/sql-database";
import { parseBody } from "./body";
import { missingTeamRepository } from "./session-team-grants";
import {
  error,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  json,
  requireSession,
  type RequestContext,
} from "./shared";

const visibilityBody = z.strictObject({
  visibility: sessionVisibilitySchema,
  includeChildren: z.boolean().default(true),
});
const scopeBody = z.strictObject({
  teamId: z.string().min(1).nullable(),
  includeChildren: z.boolean().default(true),
  joinTeam: z.boolean().default(false),
});

function denied(reason: string): Response {
  return json({ error: "Forbidden", code: "session_action_denied", reason_code: reason }, 403);
}

async function admitDescendants(
  ctx: RequestContext,
  env: Env,
  ids: readonly string[],
  action: SessionAction
): Promise<Response | null> {
  for (const id of ids.slice(1)) {
    const result = await evaluateSessionAdmission(ctx, env, id, action, null, true);
    if (result.kind === "not_found") return error("Session not found", 404);
    if (result.kind === "action_denied") return denied(result.reason);
  }
  return null;
}

async function changeVisibility(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, visibilityBody, "Invalid visibility");
  if (body instanceof Response) return body;
  const admission = ctx.sessionAdmission!;
  if (admission.viewer.kind !== "user") return denied("missing_permission");
  const actorUserId = admission.viewer.userId;
  if (body.visibility === "team" && !admission.row.ownerTeamId)
    return json({ error: "A team is required", code: "team_required" }, 400);
  const store = new SessionIndexStore(ctx.db);
  const scope = new SessionScopeStore(ctx.db);
  const ids = [
    params.id,
    ...(body.includeChildren ? await scope.listDescendantIds(params.id) : []),
  ];
  const descendantDenial = await admitDescendants(ctx, env, ids, "changeVisibility");
  if (descendantDenial) return descendantDenial;
  const rows = [admission.row, ...(await Promise.all(ids.slice(1).map((id) => store.get(id))))];
  if (body.visibility === "private" && rows.some((row) => !row?.userId))
    return json({ error: "Session owner required", code: "owner_required" }, 400);
  if (body.visibility === "team" && rows.some((row) => !row?.ownerTeamId))
    return json({ error: "A team is required", code: "team_required" }, 400);
  const auditStore = new SessionAuditStore(ctx.db);
  const audits = rows.flatMap((row) =>
    row && row.visibility !== body.visibility
      ? [
          {
            sessionId: row.id,
            statement: auditStore.bind(
              {
                requestId: ctx.request_id,
                actorUserId,
                action: "session.visibility_changed",
                sessionId: row.id,
                teamId: row.ownerTeamId,
                before: { visibility: row.visibility },
                after: { visibility: body.visibility },
              },
              true
            ),
          },
        ]
      : []
  );
  await scope.updateVisibility(ids, body.visibility, audits);
  return json({ sessionId: params.id, visibility: body.visibility, affectedSessionIds: ids });
}

async function moveSession(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, scopeBody, "Invalid scope");
  if (body instanceof Response) return body;
  const admission = ctx.sessionAdmission!;
  if (admission.viewer.kind !== "user") return denied("missing_permission");
  const actorUserId = admission.viewer.userId;
  const store = new SessionIndexStore(ctx.db);
  const scope = new SessionScopeStore(ctx.db);
  const ids = [
    params.id,
    ...(body.includeChildren ? await scope.listDescendantIds(params.id) : []),
  ];
  const descendantDenial = await admitDescendants(ctx, env, ids, "move");
  if (descendantDenial) return descendantDenial;
  const rows = [
    admission.row,
    ...(await Promise.all(ids.slice(1).map((id) => store.get(id)))),
  ].filter((row): row is SessionEntry => row !== null);
  if (rows.length !== ids.length) return error("Session not found", 404);
  const changedRows = rows.filter(
    (row) => row.ownerTeamId !== body.teamId || (body.teamId === null && row.visibility === "team")
  );
  const beforeStatements: SqlStatement[] = [];
  let requiredMemberUserId: string | undefined;
  if (body.teamId) {
    const team = await new TeamStore(ctx.db).getById(body.teamId);
    if (!team) return error("Team not found", 404);
    if (team.archivedAt !== null)
      return json({ error: "Team archived", code: "team_archived" }, 409);
    const memberships = new TeamMembershipStore(ctx.db);
    const member = admission.viewer.memberships.has(body.teamId);
    if (!member && (!body.joinTeam || team.joinPolicy !== "open")) return denied("not_member");
    requiredMemberUserId = actorUserId;
    for (const id of ids) {
      const missing = await missingTeamRepository(
        ctx.db,
        body.teamId,
        await scope.listRepositoryIds(id)
      );
      if (missing)
        return json(
          {
            error: "Target team lacks repository grant",
            code: "target_team_missing_grant",
            repository: `${missing.repoOwner}/${missing.repoName}`,
          },
          409
        );
    }
    if (!member) {
      beforeStatements.push(
        memberships.bindAddIfJoinable(body.teamId, admission.viewer.userId),
        new TeamAuditStore(ctx.db).bind(
          {
            requestId: ctx.request_id,
            actorUserId: admission.viewer.userId,
            action: "team.member_joined",
            teamId: body.teamId,
            targetUserId: admission.viewer.userId,
            before: {},
            after: { role: "member" },
          },
          true
        )
      );
    }
  }
  if (changedRows.length === 0) {
    return json({ sessionId: params.id, ownerTeamId: body.teamId, affectedSessionIds: [] });
  }
  const auditStore = new SessionAuditStore(ctx.db);
  const audits = changedRows.map((row) => ({
    sessionId: row.id,
    statement: auditStore.bind(
      {
        requestId: ctx.request_id,
        actorUserId,
        action: "session.moved",
        sessionId: row.id,
        teamId: body.teamId,
        before: { teamId: row.ownerTeamId, visibility: row.visibility },
        after: {
          teamId: body.teamId,
          visibility:
            body.teamId === null && row.visibility === "team" ? "workspace" : row.visibility,
        },
      },
      true
    ),
  }));
  if (
    !(await scope.updateOwnerTeam(
      changedRows.map((row) => row.id),
      body.teamId,
      audits,
      beforeStatements,
      requiredMemberUserId
    ))
  ) {
    if (body.teamId) {
      if (!(await new TeamStore(ctx.db).isActive(body.teamId))) {
        return json({ error: "Team archived", code: "team_archived" }, 409);
      }
      if (!(await new TeamMembershipStore(ctx.db).listForUser(actorUserId)).has(body.teamId)) {
        return denied("not_member");
      }
    }
    return error("Session not found", 404);
  }
  return json({
    sessionId: params.id,
    ownerTeamId: body.teamId,
    affectedSessionIds: changedRows.map((row) => row.id),
  });
}

async function changeCollaborator(
  _request: Request,
  _env: Env,
  params: { id: string; userId: string },
  ctx: RequestContext,
  remove: boolean
) {
  const admission = ctx.sessionAdmission!;
  if (admission.viewer.kind !== "user") return denied("missing_permission");
  if (remove && admission.viewer.userId !== params.userId) {
    const access = checkSessionAccess(admission.viewer, admission.row, "manageCollaborators");
    if (!access.allowed) return denied(access.reason);
  }
  if (!remove) {
    const user = z
      .object({ suspended_at: z.number().nullable(), role_id: z.string().nullable() })
      .nullable()
      .parse(
        await ctx.db
          .prepare(
            `SELECT users.suspended_at, assignment.role_id FROM users
             LEFT JOIN user_role_assignments assignment ON assignment.user_id = users.id
             WHERE users.id = ?`
          )
          .bind(params.userId)
          .first()
      );
    if (!user) return error("User not found", 404);
    if (user.suspended_at !== null || user.role_id === null)
      return json({ error: "User inactive", code: "user_inactive" }, 409);
  }
  if (admission.row.collaboratorIds.includes(params.userId) === !remove) {
    return json({ sessionId: params.id, userId: params.userId, status: "unchanged" });
  }
  const audit = {
    requestId: ctx.request_id,
    actorUserId: admission.viewer.userId,
    sessionId: params.id,
    action: remove ? "session.collaborator_removed" : "session.collaborator_added",
    teamId: admission.row.ownerTeamId,
    targetUserId: params.userId,
    before: { collaborator: remove },
    after: { collaborator: !remove },
  } as const;
  const store = new SessionCollaboratorStore(ctx.db);
  const changed = remove
    ? await store.remove(params.id, params.userId, audit)
    : await store.add(params.id, params.userId, admission.viewer.userId, audit);
  return json({
    sessionId: params.id,
    userId: params.userId,
    status: changed ? "updated" : "unchanged",
  });
}

async function listCollaboratorCandidates(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  return json(await new UserStore(ctx.db).listCollaboratorCandidates());
}

export const sessionScopeRoutes = new Hono<ControlPlaneHonoEnv>();
const always = (action: "changeVisibility" | "move" | "manageCollaborators" | "read") =>
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireSession(action, { enforceAlways: true }),
  });
sessionScopeRoutes.put("/sessions/:id/visibility", always("changeVisibility"), (c) =>
  dispatch(c, changeVisibility)
);
sessionScopeRoutes.put("/sessions/:id/scope", always("move"), (c) => dispatch(c, moveSession));
sessionScopeRoutes.put("/sessions/:id/collaborators/:userId", always("manageCollaborators"), (c) =>
  dispatch(c, (request, env, params, ctx) => changeCollaborator(request, env, params, ctx, false))
);
sessionScopeRoutes.delete("/sessions/:id/collaborators/:userId", always("read"), (c) =>
  dispatch(c, (request, env, params, ctx) => changeCollaborator(request, env, params, ctx, true))
);
sessionScopeRoutes.get(
  "/sessions/:id/collaborator-candidates",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: {
      ...requireSession("manageCollaborators", { enforceAlways: true }),
      auditAllowed: false,
    },
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, listCollaboratorCandidates)
);
