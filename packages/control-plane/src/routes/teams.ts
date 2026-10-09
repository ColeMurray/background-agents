import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { Hono } from "hono";
import { z } from "zod";
import {
  resolveTeamAccess,
  resolveWorkspaceTeamAccess,
} from "@open-inspect/shared/types/team-access";
import {
  createTeamRequestSchema,
  teamRoleSchema,
  teamSessionsResponseSchema,
  updateTeamRequestSchema,
  addTeamRepositoryGrantRequestSchema,
  teamRepositoryGrantsResponseSchema,
  type Team,
  type TeamRole,
} from "@open-inspect/shared/types/teams";
import { isSelfActingPrincipal } from "../auth/principal";
import {
  SESSION_INBOX_CATEGORIES,
  sessionInboxCategorySchema,
} from "@open-inspect/shared/types/session-inbox";
import {
  effectiveSessionCapabilities,
  teamsEnforcementMode,
  viewerFromContext,
} from "../authorization/session-admission";
import { SessionIndexStore } from "../db/session-index";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "../db/session-inbox-cursor";
import type { ScopedInboxSession, ListSessionInboxResult } from "../db/session-inbox-store";
import type { TeamAuditActor } from "../db/team-audit";
import {
  LastLeadError,
  TeamMembershipNotFoundError,
  TeamMembershipStore,
} from "../db/team-memberships";
import { TeamSlugConflictError, TeamStore } from "../db/teams";
import { TeamSettingsStore } from "../db/team-settings";
import {
  TeamRepositoryGrantConflictError,
  TeamRepositoryGrantStore,
} from "../db/team-repository-grants";
import type { RequestContext } from "../http/request-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { parseQuery } from "./query";
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
  resolveRepoOrError,
  type RouteAuthorization,
} from "./shared";
import { createLogger } from "../logger";

const PRIVATE = { cacheControl: "private, no-store" } as const;
const logger = createLogger("router:teams");
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

// A personal access token is its owner, so it sees that owner's teams. The
// read-only method gate keeps it out of every mutating team route.
function viewer(ctx: RequestContext) {
  if (!isSelfActingPrincipal(ctx.principal) || !ctx.authorization)
    throw new Error("Team route not admitted");
  return {
    userId: ctx.principal.userId,
    roleKey: ctx.authorization.role.key,
    suspended: ctx.authorization.suspendedAt !== null,
    permissions: ctx.authorization.permissions,
  };
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

function auditActor(ctx: RequestContext): TeamAuditActor {
  return { requestId: ctx.request_id, actorUserId: viewer(ctx).userId };
}

function mutationError(cause: unknown): Response {
  if (cause instanceof TeamRepositoryGrantConflictError) {
    return json({ error: cause.message, code: cause.code }, 409);
  }
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
  const isAdmin = isWorkspaceAdmin(subject.roleKey);
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
  const { requireTeamOnCreate } = await new TeamSettingsStore(ctx.db).get();
  return json({
    requireTeamOnCreate,
    capabilities: resolveWorkspaceTeamAccess(subject),
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
    const team = await new TeamStore(ctx.db).update(before.id, body, {
      ...auditActor(ctx),
      before,
    });
    if (!team) return error("Team not found", 404);
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
  const audit = { ...auditActor(ctx), before };
  await (archive ? store.archive(before.id, audit) : store.restore(before.id, audit));
  const team = (await store.getById(before.id))!;
  return json(await responseTeam(ctx, team));
}

async function members(_request: Request, _env: Env, _params: { id: string }, ctx: RequestContext) {
  return json({
    members: await new TeamMembershipStore(ctx.db).listMembersWithUsers(admittedTeam(ctx).id, {
      includeEmail: ctx.authorization?.permissions.includes("workspace.members.read") ?? false,
    }),
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
  const includeEmail = ctx.authorization?.permissions.includes("workspace.members.read") ?? false;
  const user = await ctx.db
    .prepare("SELECT 1 AS ok FROM users WHERE id = ?")
    .bind(params.userId)
    .first();
  if (!user) return error("User not found", 404);
  const before = (await store.listMembers(team.id)).find(
    (member) => member.userId === params.userId
  );
  if (before?.role === body.role) {
    const member = (await store.listMembersWithUsers(team.id, { includeEmail })).find(
      (row) => row.userId === params.userId
    );
    return json({ member });
  }
  try {
    if (before)
      await store.setRole(team.id, params.userId, body.role, { ...auditActor(ctx), before });
    else if (!(await store.add(team.id, params.userId, body.role, "manual", auditActor(ctx)))) {
      return json({ error: "Membership changed concurrently", code: "membership_conflict" }, 409);
    }
    const member = (await store.listMembersWithUsers(team.id, { includeEmail })).find(
      (row) => row.userId === params.userId
    );
    return json({ member });
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
  const store = new TeamMembershipStore(ctx.db);
  const before = (await store.listMembers(team.id)).find(
    (member) => member.userId === params.userId
  );
  if (!before) return error("Team membership not found", 404);
  try {
    await store.remove(team.id, params.userId, { ...auditActor(ctx), before });
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
  if (!(await new TeamMembershipStore(ctx.db).addIfJoinable(team.id, userId, auditActor(ctx)))) {
    return json({ error: "Team join is no longer available", code: "join_unavailable" }, 409);
  }
  return json(await responseTeam(ctx, team));
}

async function repositoryGrants(
  _request: Request,
  _env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  return json(
    teamRepositoryGrantsResponseSchema.parse({
      grants: await new TeamRepositoryGrantStore(ctx.db).listDetailsForTeam(admittedTeam(ctx).id),
    })
  );
}

async function putRepositoryGrant(
  request: Request,
  env: Env,
  _params: { id: string },
  ctx: RequestContext
) {
  const body = await parseBody(request, addTeamRepositoryGrantRequestSchema);
  if (body instanceof Response) return body;
  const team = admittedTeam(ctx);
  if (body.kind === "repository") {
    const repository = await resolveRepoOrError(env, body.owner, body.name, ctx, logger);
    if (repository.repoId !== body.repoExternalId) {
      return json(
        { error: "Repository identity changed", code: "repository_identity_mismatch" },
        409
      );
    }
    body.owner = repository.repoOwner;
    body.name = repository.repoName;
  }
  try {
    const grant = await new TeamRepositoryGrantStore(ctx.db).add(team.id, body, {
      actorUserId: viewer(ctx).userId,
      requestId: ctx.request_id,
    });
    return json({ grant });
  } catch (cause) {
    return mutationError(cause);
  }
}

async function deleteRepositoryGrant(
  _request: Request,
  _env: Env,
  params: { id: string; grantId: string },
  ctx: RequestContext
) {
  if (admittedTeam(ctx).archivedAt !== null) {
    return json({ error: "Team is not active", code: "team_not_active" }, 409);
  }
  const deleted = await new TeamRepositoryGrantStore(ctx.db).remove(
    admittedTeam(ctx).id,
    params.grantId,
    { actorUserId: viewer(ctx).userId, requestId: ctx.request_id }
  );
  return deleted ? new Response(null, { status: 204 }) : error("Repository grant not found", 404);
}

export const teamRoutes = new Hono<ControlPlaneHonoEnv>();
const policy = (authorization: RouteAuthorization) =>
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
teamRoutes.delete(
  "/teams/:id/members/:userId",
  policy({
    ...requireAll({
      kind: "team",
      teamIdParam: "id",
      need: "removeMember",
      targetUserIdParam: "userId",
    }),
    service: { kind: "deny" },
  }),
  (c) => dispatch(c, deleteMember)
);
teamRoutes.post("/teams/:id/join", policy(requireTeam("canJoin")), (c) => dispatch(c, joinTeam));
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
teamRoutes.get(
  "/teams/:id/repository-grants",
  policy({ ...requireTeam("member"), auditAllowed: false }),
  (c) => dispatch(c, repositoryGrants)
);
const repositoriesManage = policy(requireTeam("canManageRepositories"));
teamRoutes.put("/teams/:id/repository-grants", repositoriesManage, (c) =>
  dispatch(c, putRepositoryGrant)
);
teamRoutes.delete("/teams/:id/repository-grants/:grantId", repositoriesManage, (c) =>
  dispatch(c, deleteRepositoryGrant)
);
