/**
 * Environment CRUD routes. Internal-HMAC authenticated (the web BFF proxies
 * these). Environments are the Phase-2 session target: a named, prebuildable
 * repository set with its own secrets. Additive and dark until the web picker
 * (PR-12); the create-from-environment session path is PR-9. Secrets routes
 * live in ./environment-secrets.
 */

import { createEnvironmentInputSchema, updateEnvironmentInputSchema } from "@open-inspect/shared";
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
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  resolveRepoOrError,
} from "./shared";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";

const logger = createLogger("router:environments");

function requireDb(db: SqlDatabase): Response | null {
  if (!db) return error("Environment storage is not configured", 503);
  return null;
}

/** Turn a zod validation failure into a 400 naming the first offending field. */
function validationError(err: {
  issues: { path: (string | number | symbol)[]; message: string }[];
}): Response {
  const issue = err.issues[0];
  const prefix = issue && issue.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return error(`${prefix}${issue?.message ?? "invalid request"}`, 400);
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
 * Resolve every requested repository through the SCM provider concurrently. The
 * first failure IN INPUT ORDER wins (deterministic error). The resulting
 * inserts carry the resolved repoId, the request branch (or the freshly
 * resolved default), and position from list order. Propagates HttpError from
 * resolveRepoOrError (mapped centrally in the router's dispatch catch).
 */
async function resolveEnvironmentRepositories(
  env: Env,
  repositories: { repoOwner: string; repoName: string; baseBranch: string | null }[],
  ctx: RequestContext
): Promise<EnvironmentRepositoryInsert[]> {
  const settled = await Promise.allSettled(
    repositories.map((repository) =>
      resolveRepoOrError(env, repository.repoOwner, repository.repoName, ctx, logger)
    )
  );
  const resolved = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

  return repositories.map((repository, index) => ({
    position: index,
    repo_owner: repository.repoOwner,
    repo_name: repository.repoName,
    repo_id: resolved[index].repoId,
    base_branch: repository.baseBranch ?? resolved[index].defaultBranch,
  }));
}

async function handleListEnvironments(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(ctx.db);
  if (guard) return guard;

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
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(ctx.db);
  if (guard) return guard;

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;

  const parsed = createEnvironmentInputSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed.data;

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(ctx.db);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(ctx.db);
  const row = await store.getById(id);
  if (!row) return error("Environment not found", 404);

  return json({ environment: toEnvironment(row, await store.getRepositoriesForEnvironment(id)) });
}

async function handleUpdateEnvironment(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(ctx.db);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(ctx.db);
  const existing = await store.getById(id);
  if (!existing) return error("Environment not found", 404);

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;

  const parsed = updateEnvironmentInputSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { name, description, prebuildEnabled, channelAssociations, repositories } = parsed.data;

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(ctx.db);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

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

export const environmentRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/environments"), handler: handleListEnvironments },
  { method: "POST", pattern: parsePattern("/environments"), handler: handleCreateEnvironment },
  { method: "GET", pattern: parsePattern("/environments/:id"), handler: handleGetEnvironment },
  { method: "PUT", pattern: parsePattern("/environments/:id"), handler: handleUpdateEnvironment },
  {
    method: "DELETE",
    pattern: parsePattern("/environments/:id"),
    handler: handleDeleteEnvironment,
  },
];
