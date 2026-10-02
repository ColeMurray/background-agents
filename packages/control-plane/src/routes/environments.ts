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
  teamIdSchema,
  type SessionViewer,
} from "@open-inspect/shared";
import {
  admittedEnvironment,
  environmentActionDeniedBody,
} from "../authorization/owned-resource-admission";
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
  type EnvironmentRepositoryRow,
  type EnvironmentScalarFields,
} from "../db/environments";
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
import {
  admitTeamCatalog,
  resolveCreationOwnerTeam,
  type TeamRepositoryGrants,
} from "./team-ownership";
import { authorizeTeamRepositories } from "./workspace-repository-authorization";

const logger = createLogger("router:environments");

const listQuerySchema = z.object({
  /** A team's session catalog: environments that team's sessions may launch with. */
  teamId: z.string().optional(),
  /** Exact ownership; "null" selects workspace-owned environments. */
  ownerTeamId: z.union([z.literal("null"), teamIdSchema]).optional(),
});

function duplicateName(name: string): Response {
  return error(`An environment named "${name}" already exists`, 409);
}

/** Response shape for one environment, with the viewer's capabilities on it. */
function environmentView(
  row: EnvironmentRow,
  repositories: EnvironmentRepositoryRow[],
  viewer: SessionViewer
) {
  return {
    ...toEnvironment(row, repositories),
    capabilities: environmentCapabilities(viewer, { ownerTeamId: row.owner_team_id }),
  };
}

function targetRepositories(inserts: EnvironmentRepositoryInsert[]) {
  return inserts.map((repository) => ({
    owner: repository.repo_owner,
    name: repository.repo_name,
    repoId: repository.repo_id,
  }));
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

/**
 * Preflight the caller's repository permission before resolving IDs (resolution calls the
 * source-control provider), then check the owner team's grants against the resolved set.
 */
async function resolveAuthorizedRepositories(
  env: Env,
  ctx: RequestContext,
  ownerTeamId: string | null,
  repositories: { repoOwner: string; repoName: string; baseBranch: string | null }[]
): Promise<EnvironmentRepositoryInsert[] | Response> {
  const preflightError = await authorizeSessionTarget(ctx, {
    teamId: null,
    repositories: repositories.map((repository) => ({
      owner: repository.repoOwner,
      name: repository.repoName,
    })),
  });
  if (preflightError) return preflightError;
  const inserts = await resolveEnvironmentRepositories(env, repositories, ctx);
  const grantError = await authorizeSessionTarget(ctx, {
    teamId: ownerTeamId,
    repositories: targetRepositories(inserts),
  });
  return grantError ?? inserts;
}

/**
 * Prebuilds launch a team environment's repositories for the team, so keeping them enabled
 * re-checks the stored set against the team's current grants. Disabling them does not.
 */
async function authorizeStoredTeamRepositories(
  env: Env,
  ctx: RequestContext,
  environmentId: string,
  ownerTeamId: string
): Promise<Response | null> {
  const stored = await new EnvironmentStore(ctx.db).getRepositoriesForEnvironment(environmentId);
  const resolved = await resolveEnvironmentRepositories(
    env,
    stored.map((repository) => ({
      repoOwner: repository.repo_owner,
      repoName: repository.repo_name,
      baseBranch: repository.base_branch,
    })),
    ctx
  );
  return authorizeTeamRepositories(ctx, {
    teamId: ownerTeamId,
    repositories: targetRepositories(resolved),
  });
}

/** Whether every repository of an environment is covered by a team's grants. */
function grantsCover(
  grants: TeamRepositoryGrants,
  repositories: EnvironmentRepositoryRow[]
): boolean {
  if (repositories.length === 0) return false;
  if (grants.some((grant) => grant.grant_kind === "installation")) return true;
  const grantedRepoIds = new Set(grants.map((grant) => grant.repo_external_id));
  return repositories.every(
    (repository) => repository.repo_id !== null && grantedRepoIds.has(repository.repo_id)
  );
}

async function handleListEnvironments(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, listQuerySchema);
  if (query instanceof Response) return query;
  const catalogTeamId = query.teamId || null;
  const catalogGrants = catalogTeamId
    ? await admitTeamCatalog(request, ctx, catalogTeamId, "/environments")
    : null;
  if (catalogGrants instanceof Response) return catalogGrants;

  const store = new EnvironmentStore(ctx.db);
  const viewer = await resourceViewer(ctx);
  const { environments: rows } = await store.list(
    query.ownerTeamId === "null" ? null : query.ownerTeamId
  );
  const readable = (row: EnvironmentRow) =>
    checkEnvironmentAccess(viewer, { ownerTeamId: row.owner_team_id }, "read").allowed;
  // A team's sessions cannot launch with environments other teams own.
  const launchableByCatalogTeam = (row: EnvironmentRow) =>
    !catalogTeamId || row.owner_team_id === null || row.owner_team_id === catalogTeamId;
  let environments = rows.filter((row) => readable(row) && launchableByCatalogTeam(row));
  const repositoriesById = await store.getRepositoriesForEnvironmentIds(
    environments.map((row) => row.id)
  );
  if (catalogGrants) {
    environments = environments.filter((row) =>
      grantsCover(catalogGrants, repositoriesById.get(row.id) ?? [])
    );
  }

  return json({
    environments: environments.map((row) =>
      environmentView(row, repositoriesById.get(row.id) ?? [], viewer)
    ),
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
  const ownerTeamId = parsed.teamId ?? null;
  const ownerTeam = await resolveCreationOwnerTeam(ctx, ownerTeamId);
  if (ownerTeam instanceof Response) return ownerTeam;
  const viewer = await resourceViewer(ctx);
  const access = checkEnvironmentAccess(viewer, { ownerTeamId }, "manage");
  if (!access.allowed) return json(environmentActionDeniedBody(access.reason), 403);

  const store = new EnvironmentStore(ctx.db);
  if (await store.getByName(name, ownerTeamId)) return duplicateName(name);

  const inserts = await resolveAuthorizedRepositories(env, ctx, ownerTeamId, repositories);
  if (inserts instanceof Response) return inserts;

  const now = Date.now();
  const id = `env_${generateId()}`;
  const row: EnvironmentRow = {
    id,
    owner_team_id: ownerTeamId,
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
    // Lost a race with a concurrent create of the same name.
    if (isUniqueConstraintError(cause)) return duplicateName(name);
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
    { environment: environmentView(row, await store.getRepositoriesForEnvironment(id), viewer) },
    201
  );
}

async function handleGetEnvironment(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { environment, viewer } = admittedEnvironment(ctx);
  const repositories = await new EnvironmentStore(ctx.db).getRepositoriesForEnvironment(params.id);
  return json({ environment: environmentView(environment, repositories, viewer) });
}

async function handleUpdateEnvironment(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new EnvironmentStore(ctx.db);
  const { environment: existing, viewer } = admittedEnvironment(ctx);

  const parsed = await parseBody(request, updateEnvironmentInputSchema);
  if (parsed instanceof Response) return parsed;
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed;

  if (name !== undefined) {
    const other = await store.getByName(name, existing.owner_team_id);
    if (other && other.id !== id) return duplicateName(name);
  }

  let inserts: EnvironmentRepositoryInsert[] | undefined;
  if (repositories !== undefined) {
    const authorized = await resolveAuthorizedRepositories(
      env,
      ctx,
      existing.owner_team_id,
      repositories
    );
    if (authorized instanceof Response) return authorized;
    inserts = authorized;
  }

  const prebuildsStayEnabled = prebuildEnabled ?? existing.prebuild_enabled === 1;
  if (inserts === undefined && prebuildsStayEnabled && existing.owner_team_id !== null) {
    const grantError = await authorizeStoredTeamRepositories(env, ctx, id, existing.owner_team_id);
    if (grantError) return grantError;
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
    // Lost a race with a concurrent rename to the same name.
    if (isUniqueConstraintError(cause)) return duplicateName(name ?? existing.name);
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
    environment: environmentView(updated, await store.getRepositoriesForEnvironment(id), viewer),
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
