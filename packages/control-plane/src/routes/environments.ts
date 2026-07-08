/**
 * Environment CRUD + environment-secrets routes.
 *
 * Internal-HMAC authenticated (the web BFF proxies these). Environments are the
 * Phase-2 launch unit: a named, prebuildable repository set with its own
 * secrets. Routes are additive and dark until the web picker (PR-12) surfaces
 * them; the create-from-environment session path is PR-9.
 */

import { createEnvironmentInputSchema, updateEnvironmentInputSchema } from "@open-inspect/shared";
import {
  EnvironmentStore,
  toEnvironment,
  type EnvironmentRow,
  type EnvironmentRepositoryInsert,
} from "../db/environments";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SecretsValidationError, normalizeKey, validateKey } from "../db/secrets-validation";
import { generateId } from "../auth/crypto";
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

const logger = createLogger("router:environments");

// ─── Guards & helpers ────────────────────────────────────────────────────────

function requireDb(env: Env): Response | null {
  if (!env.DB) return error("Environment storage is not configured", 503);
  return null;
}

function requireSecretsConfig(env: Env): { key: string } | Response {
  if (!env.DB) return error("Secrets storage is not configured", 503);
  if (!env.REPO_SECRETS_ENCRYPTION_KEY)
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  return { key: env.REPO_SECRETS_ENCRYPTION_KEY };
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

// ─── Environment CRUD ────────────────────────────────────────────────────────

async function handleListEnvironments(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(env);
  if (guard) return guard;

  const store = new EnvironmentStore(env.DB);
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
  const guard = requireDb(env);
  if (guard) return guard;

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;

  const parsed = createEnvironmentInputSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { name, description, prebuildEnabled, repositories } = parsed.data;

  const store = new EnvironmentStore(env.DB);
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

  return json(
    { environment: toEnvironment(row, await store.getRepositoriesForEnvironment(id)) },
    201
  );
}

async function handleGetEnvironment(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const guard = requireDb(env);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
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
  const guard = requireDb(env);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
  const existing = await store.getById(id);
  if (!existing) return error("Environment not found", 404);

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;

  const parsed = updateEnvironmentInputSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { name, description, prebuildEnabled, repositories } = parsed.data;

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

  const fields: Partial<Pick<EnvironmentRow, "name" | "description" | "prebuild_enabled">> = {};
  if (name !== undefined) fields.name = name;
  if (description !== undefined) fields.description = normalizeDescription(description);
  if (prebuildEnabled !== undefined) fields.prebuild_enabled = prebuildEnabled ? 1 : 0;

  const updated = await store.update(id, fields, inserts);
  if (!updated) return error("Environment not found", 404);

  logger.info("environment.updated", {
    event: "environment.updated",
    environment_id: id,
    repositories_replaced: inserts !== undefined,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

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
  const guard = requireDb(env);
  if (guard) return guard;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
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

// ─── Environment secrets ─────────────────────────────────────────────────────

async function handleListEnvironmentSecrets(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const config = requireSecretsConfig(env);
  if (config instanceof Response) return config;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
  if (!(await store.getById(id))) return error("Environment not found", 404);

  const secretsStore = new EnvironmentSecretsStore(env.DB, config.key);
  const globalStore = new GlobalSecretsStore(env.DB, config.key);

  try {
    const [secrets, globalSecrets] = await Promise.all([
      secretsStore.listSecretKeys(id),
      globalStore.listSecretKeys().catch((e) => {
        logger.warn("Failed to fetch global secrets for environment list", {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }),
    ]);
    return json({ environmentId: id, secrets, globalSecrets });
  } catch (e) {
    logger.error("Failed to list environment secrets", {
      error: e instanceof Error ? e.message : String(e),
      environment_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleSetEnvironmentSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const config = requireSecretsConfig(env);
  if (config instanceof Response) return config;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
  if (!(await store.getById(id))) return error("Environment not found", 404);

  const body = await parseJsonBody<{ secrets?: Record<string, string> }>(request);
  if (body instanceof Response) return body;
  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const secretsStore = new EnvironmentSecretsStore(env.DB, config.key);
  try {
    const result = await secretsStore.setSecrets(id, body.secrets);
    logger.info("environment.secrets_updated", {
      event: "environment.secrets_updated",
      environment_id: id,
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({
      status: "updated",
      environmentId: id,
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) return error(e.message, 400);
    logger.error("Failed to update environment secrets", {
      error: e instanceof Error ? e.message : String(e),
      environment_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleDeleteEnvironmentSecret(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const config = requireSecretsConfig(env);
  if (config instanceof Response) return config;

  const id = match.groups?.id;
  const key = match.groups?.key;
  if (!id || !key) return error("Environment ID and key are required", 400);

  const secretsStore = new EnvironmentSecretsStore(env.DB, config.key);
  try {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);

    const deleted = await secretsStore.deleteSecret(id, key);
    if (!deleted) return error("Secret not found", 404);

    logger.info("environment.secret_deleted", {
      event: "environment.secret_deleted",
      environment_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ status: "deleted", environmentId: id, key: normalizedKey });
  } catch (e) {
    if (e instanceof SecretsValidationError) return error(e.message, 400);
    logger.error("Failed to delete environment secret", {
      error: e instanceof Error ? e.message : String(e),
      environment_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * Import secrets from a member repo into the environment, ciphertext-verbatim.
 * Authorization: the source repo MUST be a current member (non-members are
 * rejected 403). The response carries key names only — never plaintext or
 * ciphertext values (design §7.4).
 */
async function handleImportEnvironmentSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const config = requireSecretsConfig(env);
  if (config instanceof Response) return config;

  const id = match.groups?.id;
  if (!id) return error("Environment ID required", 400);

  const store = new EnvironmentStore(env.DB);
  if (!(await store.getById(id))) return error("Environment not found", 404);

  const body = await parseJsonBody<{ repoOwner?: string; repoName?: string; keys?: unknown }>(
    request
  );
  if (body instanceof Response) return body;
  if (!body?.repoOwner || !body?.repoName) {
    return error("repoOwner and repoName are required", 400);
  }
  if (
    body.keys !== undefined &&
    (!Array.isArray(body.keys) || body.keys.some((k) => typeof k !== "string"))
  ) {
    return error("keys must be an array of strings", 400);
  }

  const srcOwner = body.repoOwner.trim().toLowerCase();
  const srcName = body.repoName.trim().toLowerCase();

  // Authorization: the source repo must be one of the environment's repositories.
  const envRepos = await store.getRepositoriesForEnvironment(id);
  const sourceRepo = envRepos.find((r) => r.repo_owner === srcOwner && r.repo_name === srcName);
  if (!sourceRepo) {
    return error(`${srcOwner}/${srcName} is not a member of this environment`, 403);
  }

  // Resolve the source repo_id (rows written before resolution may lack it).
  let repoId = sourceRepo.repo_id;
  if (repoId == null) {
    repoId = (await resolveRepoOrError(env, srcOwner, srcName, ctx, logger)).repoId;
  }

  const secretsStore = new EnvironmentSecretsStore(env.DB, config.key);
  try {
    const result = await secretsStore.importFromRepo(id, repoId, body.keys as string[] | undefined);
    logger.info("environment.secrets_imported", {
      event: "environment.secrets_imported",
      environment_id: id,
      source_repo: `${srcOwner}/${srcName}`,
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({
      status: "imported",
      environmentId: id,
      source: `${srcOwner}/${srcName}`,
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) return error(e.message, 400);
    logger.error("Failed to import environment secrets", {
      error: e instanceof Error ? e.message : String(e),
      environment_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
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
  {
    method: "GET",
    pattern: parsePattern("/environments/:id/secrets"),
    handler: handleListEnvironmentSecrets,
  },
  {
    method: "PUT",
    pattern: parsePattern("/environments/:id/secrets"),
    handler: handleSetEnvironmentSecrets,
  },
  {
    method: "POST",
    pattern: parsePattern("/environments/:id/secrets/import"),
    handler: handleImportEnvironmentSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/environments/:id/secrets/:key"),
    handler: handleDeleteEnvironmentSecret,
  },
];
