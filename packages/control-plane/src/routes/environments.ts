/**
 * Environment CRUD routes. Internal-HMAC authenticated (the web BFF proxies
 * these). Environments are the Phase-2 session target: a named, prebuildable
 * repository set with its own secrets. Additive and dark until the web picker
 * (PR-12); the create-from-environment session path is PR-9. Secrets routes
 * live in ./environment-secrets.
 */

import { parseBody } from "./body";
import { Hono } from "hono";
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
import { generateId } from "../auth/crypto";
import { scheduleImageBuildOnSave } from "../image-builds/save-hooks";
import { createLogger } from "../logger";
import { resolveSessionRepositories } from "../repos/resolve";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  requirePermission,
} from "./shared";
import type { Env } from "../types";

const logger = createLogger("router:environments");

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
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const store = new EnvironmentStore(ctx.db);
  const { environments, total } = await store.list();
  const repositoriesById = await store.getRepositoriesForEnvironmentIds(
    environments.map((e) => e.id)
  );

  return json({
    environments: environments.map((row) => toEnvironment(row, repositoriesById.get(row.id) ?? [])),
    total,
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

  const store = new EnvironmentStore(ctx.db);
  if (await store.getByName(name)) {
    return error(`An environment named "${name}" already exists`, 409);
  }

  const inserts = await resolveEnvironmentRepositories(env, repositories, ctx);

  const now = Date.now();
  const id = `env_${generateId()}`;
  const row: EnvironmentRow = {
    id,
    name,
    description: normalizeDescription(description),
    prebuild_enabled: prebuildEnabled ? 1 : 0,
    channel_associations: normalizeChannelAssociations(channelAssociations) ?? null,
    created_at: now,
    updated_at: now,
  };

  await store.create(row, inserts);

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
    { environment: toEnvironment(row, await store.getRepositoriesForEnvironment(id)) },
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
  const row = await store.getById(id);
  if (!row) return error("Environment not found", 404);

  return json({ environment: toEnvironment(row, await store.getRepositoriesForEnvironment(id)) });
}

async function handleUpdateEnvironment(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new EnvironmentStore(ctx.db);
  const existing = await store.getById(id);
  if (!existing) return error("Environment not found", 404);

  const parsed = await parseBody(request, updateEnvironmentInputSchema);
  if (parsed instanceof Response) return parsed;
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed;

  if (name !== undefined) {
    const other = await store.getByName(name);
    if (other && other.id !== id) {
      return error(`An environment named "${name}" already exists`, 409);
    }
  }

  const inserts =
    repositories !== undefined
      ? await resolveEnvironmentRepositories(env, repositories, ctx)
      : undefined;

  const fields: EnvironmentScalarFields = {};
  if (name !== undefined) fields.name = name;
  if (description !== undefined) fields.description = normalizeDescription(description);
  if (prebuildEnabled !== undefined) fields.prebuild_enabled = prebuildEnabled ? 1 : 0;
  const channelAssociationsColumn = normalizeChannelAssociations(channelAssociations);
  if (channelAssociationsColumn !== undefined) {
    fields.channel_associations = channelAssociationsColumn;
  }

  const updated = await store.update(id, fields, inserts);
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
    environment: toEnvironment(updated, await store.getRepositoriesForEnvironment(id)),
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
  authorization: requirePermission("environments.manage"),
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
environmentRoutes.post("/environments", ENVIRONMENTS_MANAGE, (c) =>
  dispatch(c, handleCreateEnvironment)
);
environmentRoutes.get(
  "/environments/:id",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("environments.read", {
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
