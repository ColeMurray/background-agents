/**
 * Environment secrets routes: per-environment secret CRUD plus the member-scoped,
 * value-free import. Internal-HMAC authenticated (the web BFF proxies these).
 * Split from ./environments so each routes file stays focused.
 */

import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { EnvironmentSecretsStore } from "../db/environment-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SecretsValidationError, normalizeKey, validateKey } from "../db/secrets-validation";
import {
  scheduleImageBuildOnSave,
  supersedeImageBuildsForSecretsChange,
} from "../image-builds/save-hooks";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  json,
  error,
  parseJsonBody,
  resolveRepoOrError,
  requirePermission,
} from "./shared";
import {
  environmentSecretsImportBodySchema,
  secretsRequestBodySchema,
} from "./secret-request-schemas";
import type { Env } from "../types";

const logger = createLogger("router:environment-secrets");

/**
 * Post-mutation hook (design §7.4): supersede every live image — their baked
 * secrets are now outdated — then kick a rebuild for prebuild-enabled
 * environments. The supersede is awaited and fail-visible: the secrets are
 * already stored at this point, so a failure returns a distinct error telling
 * the caller to retry (a retried mutation re-runs the supersede) instead of
 * masquerading as a failed write. The rebuild is detached and best-effort.
 */
async function invalidateImagesAfterSecretsChange(
  env: Env,
  environment: EnvironmentRow,
  ctx: RequestContext
): Promise<Response | null> {
  try {
    await supersedeImageBuildsForSecretsChange({ kind: "environment", id: environment.id }, ctx);
  } catch (e) {
    logger.error("environment.secrets_image_invalidation_failed", {
      environment_id: environment.id,
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      "Secrets were saved, but prebuilt image invalidation failed — retry the update",
      500
    );
  }
  if (environment.prebuild_enabled === 1) {
    scheduleImageBuildOnSave(env, { kind: "environment", id: environment.id }, ctx);
  }
  return null;
}

/**
 * Require the secrets encryption key, returning the resolved key so handlers
 * use `config.key` instead of a non-null assertion on the optional env.
 */
function requireSecretsConfig(env: Env): { key: string } | Response {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY)
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  return { key: env.REPO_SECRETS_ENCRYPTION_KEY };
}

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

  const store = new EnvironmentStore(ctx.db);
  if (!(await store.getById(id))) return error("Environment not found", 404);

  const secretsStore = new EnvironmentSecretsStore(ctx.db, config.key);
  const globalStore = new GlobalSecretsStore(ctx.db, config.key);

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

  const store = new EnvironmentStore(ctx.db);
  const environment = await store.getById(id);
  if (!environment) return error("Environment not found", 404);

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  const parsedBody = secretsRequestBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return error("Request body must include secrets object", 400);
  }
  const body = parsedBody.data;

  const secretsStore = new EnvironmentSecretsStore(ctx.db, config.key);
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
    const invalidationError = await invalidateImagesAfterSecretsChange(env, environment, ctx);
    if (invalidationError) return invalidationError;
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

  const secretsStore = new EnvironmentSecretsStore(ctx.db, config.key);
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
    const environment = await new EnvironmentStore(ctx.db).getById(id);
    if (environment) {
      const invalidationError = await invalidateImagesAfterSecretsChange(env, environment, ctx);
      if (invalidationError) return invalidationError;
    }
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

  const store = new EnvironmentStore(ctx.db);
  const environment = await store.getById(id);
  if (!environment) return error("Environment not found", 404);

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  const parsedBody = environmentSecretsImportBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    if (issue?.path[0] === "keys") return error("keys must be an array of strings", 400);
    return error("repoOwner and repoName are required", 400);
  }
  const body = parsedBody.data;

  const srcOwner = body.repoOwner;
  const srcName = body.repoName;

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

  const secretsStore = new EnvironmentSecretsStore(ctx.db, config.key);
  try {
    const result = await secretsStore.importFromRepo(id, repoId, body.keys);
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
    const invalidationError = await invalidateImagesAfterSecretsChange(env, environment, ctx);
    if (invalidationError) return invalidationError;
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

export const environmentSecretsRoutes: Route[] = defineRoutes(GITHUB_USER_OR_SERVICE_ROUTE, [
  {
    method: "GET",
    path: "/environments/:id/secrets",
    authorization: requirePermission("environments.secrets.manage"),
    handler: handleListEnvironmentSecrets,
  },
  {
    method: "PUT",
    path: "/environments/:id/secrets",
    authorization: requirePermission("environments.secrets.manage"),
    handler: handleSetEnvironmentSecrets,
  },
  {
    method: "POST",
    path: "/environments/:id/secrets/import",
    authorization: requirePermission("environments.secrets.manage"),
    handler: handleImportEnvironmentSecrets,
  },
  {
    method: "DELETE",
    path: "/environments/:id/secrets/:key",
    authorization: requirePermission("environments.secrets.manage"),
    handler: handleDeleteEnvironmentSecret,
  },
]);
