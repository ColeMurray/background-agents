/**
 * Environment CRUD routes. Internal-HMAC authenticated (the web BFF proxies
 * these). Environments are the Phase-2 session target: a named, prebuildable
 * repository set with its own secrets. Additive and dark until the web picker
 * (PR-12); the create-from-environment session path is PR-9. Secrets routes
 * live in ./environment-secrets.
 */

import { parseBody } from "./body";
import { Hono } from "hono";
import { z } from "zod";
import {
  checkEnvironmentAccess,
  environmentCapabilities,
  type SessionViewer,
} from "@open-inspect/shared";
import { resourceViewer } from "../authorization/resource-viewer";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  createEnvironmentInputSchema,
  updateEnvironmentInputSchema,
} from "@open-inspect/shared/types/environments";
import {
  EnvironmentStore,
  toEnvironment,
  type EnvironmentRow,
  type EnvironmentRepositoryInsert,
  type EnvironmentScalarFields,
} from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamSettingsStore } from "../db/team-settings";
import { TeamStore } from "../db/teams";
import { auditRouteAuthorizationDecision } from "../authorization/request-audit";
import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "../db/errors";
import { scheduleImageBuildOnSave } from "../image-builds/save-hooks";
import { createLogger } from "../logger";
import { resolveSessionRepositories } from "../repos/resolve";
import { parseQuery } from "./query";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  requirePermission,
  requireEnvironment,
} from "./shared";
import type { Env } from "../types";
import { authorizeSessionTarget } from "./session-target-authorization";
import { authorizeTeamRepositories } from "./workspace-repository-authorization";

const logger = createLogger("router:environments");
const listQuerySchema = z.object({
  ownerTeamId: z.union([z.literal("null"), z.string().regex(/^team_[A-Za-z0-9_-]+$/)]).optional(),
});

function denied(reason: string): Response {
  return json({ error: "Forbidden", code: "environment_action_denied", reason_code: reason }, 403);
}

function archivedTeam(): Response {
  return json({ error: "Team archived", code: "team_archived", reason_code: "team_archived" }, 409);
}

function responseCapabilities(viewer: SessionViewer, ownerTeamId: string | null) {
  const { canRead, canManage, canUse } = environmentCapabilities(viewer, { ownerTeamId });
  return { canRead, canManage, canUse };
}

/** Empty/whitespace description collapses to null (the column is nullable). */
function normalizeDescription(description: string | null | undefined): string | null {
  return description && description.length > 0 ? description : null;
}

/**
 * Column value for a channel-association set: deduplicated JSON array, with an
 * empty set collapsing to NULL. `undefined` (field absent from the request)
 * stays `undefined` so updates leave the column untouched.
 */
function normalizeChannelAssociations(channels: string[] | undefined): string | null | undefined {
  if (channels === undefined) return undefined;
  const unique = [...new Set(channels)];
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

/**
 * Resolve and validate the ordered repository set exactly as session launch
 * does, then adapt the canonical refs for environment persistence.
 */
export async function resolveEnvironmentRepositories(
  env: Env,
  repositories: { repoOwner: string; repoName: string; baseBranch: string | null }[],
  ctx: RequestContext
): Promise<EnvironmentRepositoryInsert[]> {
  const resolved = await resolveSessionRepositories(env, repositories, ctx, logger);
  return resolved.map((repository, index) => ({
    position: index,
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    repo_id: repository.repoId,
    base_branch: repository.baseBranch,
  }));
}

async function handleListEnvironments(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, listQuerySchema);
  if (query instanceof Response) return query;
  const teamId = new URL(request.url).searchParams.get("teamId");
  let grants: Awaited<ReturnType<TeamRepositoryGrantStore["listForTeam"]>> | undefined;
  if (teamId) {
    const userId = ctx.authorization?.userId;
    const roleKey = ctx.authorization?.role.key;
    const allowed =
      !!userId &&
      (await new TeamStore(ctx.db).isActive(teamId)) &&
      (roleKey === "owner" ||
        roleKey === "administrator" ||
        (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(userId)).has(
          teamId
        ));
    if (!allowed) {
      const response = error("Team not found", 404);
      await auditRouteAuthorizationDecision({
        ctx,
        method: request.method,
        path: "/environments",
        response,
        teamId,
        decision: {
          kind: "denied",
          reasonCode: "team_not_visible",
          reason: "Team not found",
          requirements: [{ kind: "team", teamIdParam: "teamId", need: "member" }],
          effectivePermissions: [],
        },
      });
      return response;
    }
    grants = await new TeamRepositoryGrantStore(ctx.db).listForTeam(teamId);
  }

  const store = new EnvironmentStore(ctx.db);
  const viewer = await resourceViewer(ctx);
  const rows = await store.list(query.ownerTeamId === "null" ? null : query.ownerTeamId);
  let environments = rows.environments.filter(
    (row) =>
      checkEnvironmentAccess(viewer, { ownerTeamId: row.owner_team_id }, "read").allowed &&
      // Actorless bots launch workspace sessions only, so they see workspace environments.
      (viewer.kind !== "service" || row.owner_team_id === null) &&
      // A team's session catalog excludes environments other teams own.
      (!teamId || row.owner_team_id === null || row.owner_team_id === teamId)
  );
  const repositoriesById = await store.getRepositoriesForEnvironmentIds(
    environments.map((e) => e.id)
  );
  if (grants) {
    const installationGrant = grants.some((grant) => grant.grant_kind === "installation");
    const grantedRepoIds = new Set(grants.map((grant) => grant.repo_external_id));
    environments = environments.filter((row) => {
      const repositories = repositoriesById.get(row.id) ?? [];
      return (
        repositories.length > 0 &&
        (installationGrant ||
          repositories.every(
            (repository) => repository.repo_id !== null && grantedRepoIds.has(repository.repo_id)
          ))
      );
    });
  }

  return json({
    environments: environments.map((row) => ({
      ...toEnvironment(row, repositoriesById.get(row.id) ?? []),
      capabilities: responseCapabilities(viewer, row.owner_team_id),
    })),
    total: environments.length,
  });
}

async function handleCreateEnvironment(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const parsed = await parseBody(request, createEnvironmentInputSchema);
  if (parsed instanceof Response) return parsed;
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed;
  const teamId = parsed.teamId ?? null;
  if (teamId === null && (await new TeamSettingsStore(ctx.db).get()).requireTeamOnCreate) {
    return json({ error: "A team is required", code: "team_required" }, 400);
  }
  if (teamId !== null) {
    const team = await new TeamStore(ctx.db).getById(teamId);
    if (!team) return error("Team not found", 404);
    if (team.archivedAt !== null) return archivedTeam();
  }
  const viewer = await resourceViewer(ctx);
  const access = checkEnvironmentAccess(viewer, { ownerTeamId: teamId }, "manage");
  if (!access.allowed) return denied(access.reason);

  const store = new EnvironmentStore(ctx.db);
  if (await store.getByName(name, teamId)) {
    return error(`An environment named "${name}" already exists`, 409);
  }

  const targetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId: null,
    repositories: repositories.map((repository) => ({
      owner: repository.repoOwner,
      name: repository.repoName,
    })),
  });
  if (targetAuthorizationError) return targetAuthorizationError;

  const inserts = await resolveEnvironmentRepositories(env, repositories, ctx);
  const resolvedTargetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId,
    repositories: inserts.map((repository) => ({
      owner: repository.repo_owner,
      name: repository.repo_name,
      repoId: repository.repo_id,
    })),
  });
  if (resolvedTargetAuthorizationError) return resolvedTargetAuthorizationError;

  const now = Date.now();
  const id = `env_${generateId()}`;
  const row: EnvironmentRow = {
    id,
    owner_team_id: teamId,
    name,
    description: normalizeDescription(description),
    prebuild_enabled: prebuildEnabled ? 1 : 0,
    channel_associations: normalizeChannelAssociations(channelAssociations) ?? null,
    created_at: now,
    updated_at: now,
  };

  try {
    await store.create(row, inserts);
  } catch (cause) {
    if (isUniqueConstraintError(cause))
      return error(`An environment named "${name}" already exists`, 409);
    throw cause;
  }

  logger.info("environment.created", {
    event: "environment.created",
    environment_id: id,
    repository_count: inserts.length,
    prebuild_enabled: row.prebuild_enabled === 1,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  if (row.prebuild_enabled === 1) {
    scheduleImageBuildOnSave(env, { kind: "environment", id }, ctx);
  }

  return json(
    {
      environment: {
        ...toEnvironment(row, await store.getRepositoriesForEnvironment(id)),
        capabilities: responseCapabilities(viewer, teamId),
      },
    },
    201
  );
}

async function handleGetEnvironment(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new EnvironmentStore(ctx.db);
  const { environment: row, viewer } = ctx.environmentAdmission!;

  return json({
    environment: {
      ...toEnvironment(row, await store.getRepositoriesForEnvironment(id)),
      capabilities: responseCapabilities(viewer, row.owner_team_id),
    },
  });
}

async function handleUpdateEnvironment(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new EnvironmentStore(ctx.db);
  const { environment: existing, viewer } = ctx.environmentAdmission!;

  const parsed = await parseBody(request, updateEnvironmentInputSchema);
  if (parsed instanceof Response) return parsed;
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed;

  if (name !== undefined) {
    const other = await store.getByName(name, existing.owner_team_id);
    if (other && other.id !== id) {
      return error(`An environment named "${name}" already exists`, 409);
    }
  }

  let inserts: EnvironmentRepositoryInsert[] | undefined;
  if (repositories !== undefined) {
    const targetAuthorizationError = await authorizeSessionTarget(ctx, {
      teamId: null,
      repositories: repositories.map((repository) => ({
        owner: repository.repoOwner,
        name: repository.repoName,
      })),
    });
    if (targetAuthorizationError) return targetAuthorizationError;

    inserts = await resolveEnvironmentRepositories(env, repositories, ctx);
    const resolvedTargetAuthorizationError = await authorizeSessionTarget(ctx, {
      teamId: existing.owner_team_id,
      repositories: inserts.map((repository) => ({
        owner: repository.repo_owner,
        name: repository.repo_name,
        repoId: repository.repo_id,
      })),
    });
    if (resolvedTargetAuthorizationError) return resolvedTargetAuthorizationError;
  }

  if (
    (prebuildEnabled ?? existing.prebuild_enabled === 1) &&
    existing.owner_team_id !== null &&
    inserts === undefined
  ) {
    const existingRepositories = await store.getRepositoriesForEnvironment(id);
    const resolved = await resolveEnvironmentRepositories(
      env,
      existingRepositories.map((repository) => ({
        repoOwner: repository.repo_owner,
        repoName: repository.repo_name,
        baseBranch: repository.base_branch,
      })),
      ctx
    );
    const denied = await authorizeTeamRepositories(ctx, {
      teamId: existing.owner_team_id,
      repositories: resolved.map((repository) => ({
        owner: repository.repo_owner,
        name: repository.repo_name,
        repoId: repository.repo_id,
      })),
    });
    if (denied) return denied;
  }

  const fields: EnvironmentScalarFields = {};
  if (name !== undefined) fields.name = name;
  if (description !== undefined) fields.description = normalizeDescription(description);
  if (prebuildEnabled !== undefined) fields.prebuild_enabled = prebuildEnabled ? 1 : 0;
  const channelAssociationsColumn = normalizeChannelAssociations(channelAssociations);
  if (channelAssociationsColumn !== undefined) {
    fields.channel_associations = channelAssociationsColumn;
  }

  let updated: EnvironmentRow | null;
  try {
    updated = await store.update(id, fields, inserts);
  } catch (cause) {
    if (isUniqueConstraintError(cause))
      return error(`An environment named "${name ?? existing.name}" already exists`, 409);
    throw cause;
  }
  if (!updated) return error("Environment not found", 404);

  logger.info("environment.updated", {
    event: "environment.updated",
    environment_id: id,
    repositories_replaced: inserts !== undefined,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  if (updated.prebuild_enabled === 1) {
    scheduleImageBuildOnSave(env, { kind: "environment", id }, ctx);
  }

  return json({
    environment: {
      ...toEnvironment(updated, await store.getRepositoriesForEnvironment(id)),
      capabilities: responseCapabilities(viewer, updated.owner_team_id),
    },
  });
}

async function handleDeleteEnvironment(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new EnvironmentStore(ctx.db);
  const deleted = await store.delete(id);
  if (!deleted) return error("Environment not found", 404);

  logger.info("environment.deleted", {
    event: "environment.deleted",
    environment_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted", id });
}

const ENVIRONMENTS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requireEnvironment("manage"),
});

export const environmentRoutes = new Hono<ControlPlaneHonoEnv>();

environmentRoutes.get(
  "/environments",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("environments.read", {
      actorlessGrants: [{ service: "slack-bot" }, { service: "linear-bot" }],
    }),
  }),
  (c) => dispatch(c, handleListEnvironments)
);
environmentRoutes.post(
  "/environments",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("environments.manage"),
  }),
  (c) => dispatch(c, handleCreateEnvironment)
);
environmentRoutes.get(
  "/environments/:id",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requireEnvironment("read", "id", {
      actorlessGrants: [{ service: "github-bot" }],
    }),
  }),
  (c) => dispatch(c, handleGetEnvironment)
);
environmentRoutes.put("/environments/:id", ENVIRONMENTS_MANAGE, (c) =>
  dispatch(c, handleUpdateEnvironment)
);
environmentRoutes.delete("/environments/:id", ENVIRONMENTS_MANAGE, (c) =>
  dispatch(c, handleDeleteEnvironment)
);
