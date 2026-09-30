import { Hono } from "hono";
import { z } from "zod";
import { resolveTeamAccess } from "@open-inspect/shared/types/team-access";
import {
  createTeamRequestSchema,
  teamRoleSchema,
  teamSessionsResponseSchema,
  teamActivityResponseSchema,
  updateTeamRequestSchema,
  type Team,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import {
  SESSION_INBOX_CATEGORIES,
  sessionInboxCategorySchema,
} from "@open-inspect/shared/types/session-inbox";
import {
  effectiveSessionCapabilities,
  teamsEnforcementMode,
  viewerFromContext,
} from "../authorization/session-admission";
import { AuditEventStore, toAuditEvent } from "../db/audit-event-store";
import { encodeAuditEventCursor } from "../db/audit-event-cursor";
import { SessionIndexStore } from "../db/session-index";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "../db/session-inbox-cursor";
import type { ScopedInboxSession, ListSessionInboxResult } from "../db/session-inbox-store";
import { TeamAuditStore, type TeamAuditInput } from "../db/team-audit";
import {
  LastLeadError,
  TeamMembershipNotFoundError,
  TeamMembershipStore,
} from "../db/team-memberships";
import { TeamSlugConflictError, TeamStore } from "../db/teams";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { parseQuery } from "./query";
import { auditEventQuery } from "./audit-events";
import { SESSION_INBOX_LIMIT } from "./session-index";
import {
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  error,
  json,
  requirePermission,
  requireTeam,
  requireAll,
  permissionRequirement,
} from "./shared";

const PRIVATE = { cacheControl: "private, no-store" } as const;
const ACTIVE_USER = {
  kind: "active-global",
  service: { kind: "deny" },
  auditAllowed: false,
} as const;
const querySchema = z.object({
  membership: z.enum(["mine", "all"]).optional(),
  search: z.string().optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
});
const sessionsQuerySchema = z.object({
  bucket: sessionInboxCategorySchema.optional(),
  cursor: z.string().min(1, { error: "Invalid cursor" }).optional(),
});
const activityQuerySchema = auditEventQuery.extend({
  action: z.string().min(1, { error: "Invalid action" }).optional(),
});

function viewer(ctx: RequestContext) {
  if (ctx.principal?.kind !== "user" || !ctx.authorization)
    throw new Error("Team route not admitted");
  return { userId: ctx.principal.userId, roleKey: ctx.authorization.role.key };
}

async function responseTeam(
  ctx: RequestContext,
  team: Team,
  memberships?: ReadonlyMap<string, TeamRole>,
  leadCount?: number,
  memberCount?: number
) {
  const subject = viewer(ctx);
  const store = new TeamMembershipStore(ctx.db);
  const roles = memberships ?? (await store.listForUser(subject.userId));
  return {
    ...team,
    memberCount: memberCount ?? (await store.countMembers(team.id)),
    capabilities: resolveTeamAccess(
      { ...subject, memberships: roles },
      { ...team, leadCount: leadCount ?? (await store.countLeads(team.id)) }
    ),
  };
}

function admittedTeam(ctx: RequestContext): Team {
  if (!ctx.teamAdmission) throw new Error("Team route not admitted");
  return ctx.teamAdmission.team;
}

async function auditTeamEvent(
  input: Omit<TeamAuditInput, "requestId" | "actorUserId" | "teamId"> & {
    ctx: RequestContext;
    team: Team;
  }
): Promise<void> {
  const { ctx, team, ...event } = input;
  await new TeamAuditStore(ctx.db).write({
    ...event,
    requestId: ctx.request_id,
    actorUserId: viewer(ctx).userId,
    teamId: team.id,
  });
}

function mutationError(cause: unknown): Response {
  if (cause instanceof LastLeadError) return json({ error: cause.message, code: "last_lead" }, 409);
  if (cause instanceof TeamMembershipNotFoundError) return error("Team membership not found", 404);
  if (cause instanceof TeamSlugConflictError) {
    return json({ error: "Team slug already exists", code: "slug_taken" }, 409);
  }
  if (cause instanceof Error && cause.message === "Default environment must belong to the team") {
    return error(cause.message, 400);
  }
  throw cause;
}

async function listTeams(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const query = parseQuery(request, querySchema);
  if (query instanceof Response) return query;
  const subject = viewer(ctx);
  const isAdmin = subject.roleKey === "owner" || subject.roleKey === "administrator";
  const membershipStore = new TeamMembershipStore(ctx.db);
  const memberships = await membershipStore.listForUser(subject.userId);
  const teams = await new TeamStore(ctx.db).list({
    forUserId: query.membership === "all" ? undefined : subject.userId,
    includeArchived: query.includeArchived === "true",
    search: query.search,
  });
  const leadCounts = await membershipStore.listLeadCounts();
  const memberCounts = await membershipStore.listMemberCounts();
  return json({
    teams: await Promise.all(
      teams
        .filter((team) => team.archivedAt === null || isAdmin || memberships.has(team.id))
        .map((team) =>
          responseTeam(
            ctx,
            team,
            memberships,
            leadCounts.get(team.id) ?? 0,
            memberCounts.get(team.id) ?? 0
          )
        )
    ),
  });
}

async function meTeams(_request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const subject = viewer(ctx);
  const membershipStore = new TeamMembershipStore(ctx.db);
  const memberships = await membershipStore.listForUser(subject.userId);
  const teams = await new TeamStore(ctx.db).list({
    forUserId: subject.userId,
    includeArchived: true,
  });
  const leadCounts = await membershipStore.listLeadCounts();
  const memberCounts = await membershipStore.listMemberCounts();
  return json({
    teams: await Promise.all(
      teams.map(async (team) => ({
        ...(await responseTeam(
          ctx,
          team,
          memberships,
          leadCounts.get(team.id) ?? 0,
          memberCounts.get(team.id) ?? 0
        )),
        role: memberships.get(team.id),
      }))
    ),
  });
}

async function createTeam(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const body = await parseBody(request, createTeamRequestSchema);
  if (body instanceof Response) return body;
  try {
    const leadUserId = viewer(ctx).userId;
    const team = await new TeamStore(ctx.db).createWithLead(body, leadUserId, ctx.request_id);
    return json(await responseTeam(ctx, team), 201);
  } catch (cause) {
    return mutationError(cause);
  }
}

async function getTeam(_request: Request, _env: Env, _params: { id: string }, ctx: RequestContext) {
  return json(await responseTeam(ctx, admittedTeam(ctx)));
}

async function teamSessions(
  request: Request,
  env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const query = parseQuery(request, sessionsQuerySchema);
  if (query instanceof Response) return query;
  if (query.cursor !== undefined && query.bucket === undefined)
    return error("Bucket required for pagination", 400);
  const cursor = parseSessionInboxCursor(query.cursor);
  if (!cursor.ok) return error(cursor.error, 400);
  const subject = viewer(ctx);
  const sessionViewer = viewerFromContext(ctx, ctx.sessionMemberships ?? new Map());
  const mode = teamsEnforcementMode(ctx, env);
  const options = {
    teamIds: [admittedTeam(ctx).id],
    readScope: sessionViewer,
    mode,
    viewerUserId: subject.userId,
    limit: SESSION_INBOX_LIMIT,
  };
  const store = new SessionIndexStore(ctx.db);
  const pages =
    query.bucket === undefined
      ? await store.listInboxSnapshot(options)
      : {
          [query.bucket]: await store.listInbox({
            ...options,
            category: query.bucket,
            cursor: cursor.cursor,
          }),
        };
  const sessions = Object.values(pages).flatMap(({ items }) =>
    items.flatMap(({ rootSession, descendantSessions }) => [rootSession, ...descendantSessions])
  );
  const collaborators = await new SessionCollaboratorStore(ctx.db).listForSessions(
    sessions.map((row) => row.id),
    { privateOnly: true }
  );
  const sessionIds = new Set(sessions.map((row) => row.id));
  const decorate = (row: ScopedInboxSession) => ({
    ...row,
    parentSessionId:
      row.parentSessionId !== null && sessionIds.has(row.parentSessionId)
        ? row.parentSessionId
        : null,
    capabilities: effectiveSessionCapabilities(
      sessionViewer,
      {
        id: row.id,
        ownerUserId: row.userId,
        ownerTeamId: row.ownerTeamId,
        visibility: row.visibility,
        collaboratorIds: collaborators.get(row.id) ?? [],
      },
      mode
    ),
  });
  const encodePage = (page: ListSessionInboxResult) => ({
    items: page.items.map(({ rootSession, descendantSessions }) => ({
      rootSession: decorate(rootSession),
      descendantSessions: descendantSessions.map(decorate),
    })),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ? encodeSessionInboxCursor(page.nextCursor) : null,
  });
  return json(
    teamSessionsResponseSchema.parse(
      query.bucket === undefined
        ? {
            categories: Object.fromEntries(
              SESSION_INBOX_CATEGORIES.map((bucket) => [bucket, encodePage(pages[bucket])])
            ),
          }
        : encodePage(pages[query.bucket])
    )
  );
}

async function teamActivity(
  request: Request,
  env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const query = parseQuery(request, activityQuerySchema);
  if (query instanceof Response) return query;
  const result = await new AuditEventStore(ctx.db).list({
    ...query,
    teamId: admittedTeam(ctx).id,
    visibilityScope: {
      viewer: viewerFromContext(ctx, ctx.sessionMemberships ?? new Map()),
      mode: teamsEnforcementMode(ctx, env),
    },
  });
  return json(
    teamActivityResponseSchema.parse({
      events: result.rows.map(toAuditEvent),
      hasMore: result.hasMore,
      nextCursor: result.nextCursor ? encodeAuditEventCursor(result.nextCursor) : null,
    })
  );
}

async function updateTeam(
  request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, updateTeamRequestSchema);
  if (body instanceof Response) return body;
  const before = admittedTeam(ctx);
  try {
    const team = await new TeamStore(ctx.db).update(before.id, body);
    if (!team) return error("Team not found", 404);
    if (Object.keys(body).length > 0) {
      await auditTeamEvent({ ctx, team, action: "team.updated", before, after: team });
    }
    return json(await responseTeam(ctx, team));
  } catch (cause) {
    return mutationError(cause);
  }
}

async function setArchived(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext,
  archive: boolean
) {
  const before = admittedTeam(ctx);
  const store = new TeamStore(ctx.db);
  const changed = archive ? await store.archive(before.id) : await store.restore(before.id);
  const team = (await store.getById(before.id))!;
  if (changed)
    await auditTeamEvent({
      ctx,
      team,
      action: archive ? "team.archived" : "team.restored",
      before,
      after: team,
    });
  return json(await responseTeam(ctx, team));
}

async function members(_request: Request, _env: Env, _params: { id: string }, ctx: RequestContext) {
  return json({
    members: await new TeamMembershipStore(ctx.db).listMembersWithUsers(admittedTeam(ctx).id),
  });
}

async function putMember(
  request: Request,
  _env: Env,
  params: { id: string; userId: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, z.object({ role: teamRoleSchema }));
  if (body instanceof Response) return body;
  const team = admittedTeam(ctx);
  const store = new TeamMembershipStore(ctx.db);
  const user = await ctx.db
    .prepare("SELECT 1 AS ok FROM users WHERE id = ?")
    .bind(params.userId)
    .first();
  if (!user) return error("User not found", 404);
  const before = (await store.listMembers(team.id)).find(
    (member) => member.userId === params.userId
  );
  if (before?.role === body.role) {
    const member = (await store.listMembersWithUsers(team.id)).find(
      (row) => row.userId === params.userId
    );
    return json({ member });
  }
  try {
    if (before) await store.setRole(team.id, params.userId, body.role);
    else if (!(await store.add(team.id, params.userId, body.role))) {
      return json({ error: "Membership changed concurrently", code: "membership_conflict" }, 409);
    }
    const after = (await store.listMembersWithUsers(team.id)).find(
      (member) => member.userId === params.userId
    )!;
    await auditTeamEvent({
      ctx,
      team,
      targetUserId: params.userId,
      action: before ? "team.member_role_changed" : "team.member_added",
      before: before ?? {},
      after,
    });
    return json({ member: after });
  } catch (cause) {
    return mutationError(cause);
  }
}

async function deleteMember(
  _request: Request,
  _env: Env,
  params: { id: string; userId: string },
  ctx: RequestContext
) {
  const team = admittedTeam(ctx);
  const subject = viewer(ctx);
  const store = new TeamMembershipStore(ctx.db);
  const before = (await store.listMembers(team.id)).find(
    (member) => member.userId === params.userId
  );
  if (!before) return error("Team membership not found", 404);
  if (subject.userId !== params.userId && !ctx.teamAdmission?.access.canManageMembers) {
    return json(
      {
        error: "Forbidden",
        code: "team_capability_required",
        reason_code: "team_capability_required",
      },
      403
    );
  }
  try {
    await store.remove(team.id, params.userId);
    await auditTeamEvent({
      ctx,
      team,
      targetUserId: params.userId,
      action: "team.member_removed",
      before,
      after: {},
    });
    return new Response(null, { status: 204 });
  } catch (cause) {
    return mutationError(cause);
  }
}

async function joinTeam(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const team = admittedTeam(ctx);
  const userId = viewer(ctx).userId;
  if (!(await new TeamMembershipStore(ctx.db).addIfJoinable(team.id, userId))) {
    return json({ error: "Team join is no longer available", code: "join_unavailable" }, 409);
  }
  await auditTeamEvent({
    ctx,
    team,
    targetUserId: userId,
    action: "team.member_joined",
    before: {},
    after: { userId, role: "member" },
  });
  return json(await responseTeam(ctx, team));
}

export const teamRoutes = new Hono<ControlPlaneHonoEnv>();
const policy = (authorization: ReturnType<typeof requireTeam>) =>
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, ...PRIVATE, authorization });
const read = policy(requireTeam("read"));
const manage = policy(requireTeam("canEditMetadata"));
const membersManage = policy(requireTeam("canManageMembers"));
const archive = policy(requireTeam("canArchive"));
teamRoutes.get(
  "/me/teams",
  admit({ ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, ...PRIVATE, authorization: ACTIVE_USER }),
  (c) => dispatch(c, meTeams)
);
teamRoutes.get("/teams", policy(ACTIVE_USER), (c) => dispatch(c, listTeams));
teamRoutes.post(
  "/teams",
  policy(requirePermission("workspace.members.manage", { service: "deny" })),
  (c) => dispatch(c, createTeam)
);
teamRoutes.get("/teams/:id", read, (c) => dispatch(c, getTeam));
teamRoutes.patch("/teams/:id", manage, (c) => dispatch(c, updateTeam));
teamRoutes.post("/teams/:id/archive", archive, (c) =>
  dispatch(c, (request, env, params, ctx) => setArchived(request, env, params, ctx, true))
);
teamRoutes.post("/teams/:id/restore", archive, (c) =>
  dispatch(c, (request, env, params, ctx) => setArchived(request, env, params, ctx, false))
);
teamRoutes.get("/teams/:id/members", read, (c) => dispatch(c, members));
teamRoutes.put("/teams/:id/members/:userId", membersManage, (c) => dispatch(c, putMember));
teamRoutes.delete("/teams/:id/members/:userId", policy(requireTeam("member")), (c) =>
  dispatch(c, deleteMember)
);
teamRoutes.post("/teams/:id/join", policy(requireTeam("canJoin")), (c) => dispatch(c, joinTeam));
const member = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  ...PRIVATE,
  authorization: requireTeam("member"),
});
teamRoutes.get(
  "/teams/:id/sessions",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    ...PRIVATE,
    authorization: {
      ...requireAll(
        { kind: "team", teamIdParam: "id", need: "member" },
        permissionRequirement("sessions.read")
      ),
      service: { kind: "deny" },
    },
  }),
  (c) => dispatch(c, teamSessions)
);
teamRoutes.get("/teams/:id/activity", member, (c) => dispatch(c, teamActivity));
