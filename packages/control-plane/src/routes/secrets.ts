/**
 * Repository and global secrets routes and handlers.
 */

import { parseBody } from "./body";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { repositoryParams } from "./repository-params";
import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SecretsValidationError, normalizeKey, validateKey } from "../db/secrets-validation";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  resolveRepoOrError,
  requirePermission,
} from "./shared";
import { secretsRequestBodySchema } from "./secret-request-schemas";

const logger = createLogger("router:secrets");

/**
 * Upsert secrets for a repository.
 */
async function handleSetRepoSecrets(
  request: Request,
  env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const body = await parseBody(
    request,
    secretsRequestBodySchema,
    "Request body must include secrets object"
  );
  if (body instanceof Response) return body;

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const result = await store.setSecrets(
      resolved.repoId,
      resolved.repoOwner,
      resolved.repoName,
      body.secrets
    );

    logger.info("repo.secrets_updated", {
      event: "repo.secrets_updated",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * List secret keys for a repository.
 */
async function handleListRepoSecrets(
  _request: Request,
  env: Env,
  params: { owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);
  const globalStore = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const [secrets, globalSecrets] = await Promise.all([
      store.listSecretKeys(resolved.repoId),
      globalStore.listSecretKeys().catch((e) => {
        logger.warn("Failed to fetch global secrets for repo list", {
          error: e instanceof Error ? e.message : String(e),
        });
        return [];
      }),
    ]);

    logger.info("repo.secrets_listed", {
      event: "repo.secrets_listed",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      keys_count: secrets.length,
      global_keys_count: globalSecrets.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      secrets,
      globalSecrets,
    });
  } catch (e) {
    logger.error("Failed to list repo secrets", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

/**
 * Delete a secret for a repository.
 */
async function handleDeleteRepoSecret(
  _request: Request,
  env: Env,
  params: { owner: string; name: string; key: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const key = params.key;
  if (!key) {
    return error("Owner, name, and key are required");
  }

  const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);

  const store = new RepoSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);

    const deleted = await store.deleteSecret(resolved.repoId, key);
    if (!deleted) {
      return error("Secret not found", 404);
    }

    logger.info("repo.secret_deleted", {
      event: "repo.secret_deleted",
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "deleted",
      repo: `${resolved.repoOwner}/${resolved.repoName}`,
      key: normalizedKey,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete repo secret", {
      error: e instanceof Error ? e.message : String(e),
      repo_id: resolved.repoId,
      repo_owner: resolved.repoOwner,
      repo_name: resolved.repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleSetGlobalSecrets(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const body = await parseBody(
    request,
    secretsRequestBodySchema,
    "Request body must include secrets object"
  );
  if (body instanceof Response) return body;

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const result = await store.setSecrets(body.secrets);

    logger.info("global.secrets_updated", {
      event: "global.secrets_updated",
      keys_count: result.keys.length,
      created: result.created,
      updated: result.updated,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      keys: result.keys,
      created: result.created,
      updated: result.updated,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update global secrets", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleListGlobalSecrets(
  _request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const secrets = await store.listSecretKeys();

    logger.info("global.secrets_listed", {
      event: "global.secrets_listed",
      keys_count: secrets.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ secrets });
  } catch (e) {
    logger.error("Failed to list global secrets", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

async function handleDeleteGlobalSecret(
  _request: Request,
  env: Env,
  params: { key: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const key = params.key;
  if (!key) {
    return error("Key is required");
  }

  const store = new GlobalSecretsStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY);

  try {
    const normalizedKey = normalizeKey(key);
    validateKey(normalizedKey);

    const deleted = await store.deleteSecret(key);
    if (!deleted) {
      return error("Secret not found", 404);
    }

    logger.info("global.secret_deleted", {
      event: "global.secret_deleted",
      key: normalizedKey,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "deleted",
      key: normalizedKey,
    });
  } catch (e) {
    if (e instanceof SecretsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to delete global secret", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Secrets storage unavailable", 503);
  }
}

const REPO_SECRETS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("repositories.secrets.manage"),
});
const GLOBAL_SECRETS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("global_secrets.manage"),
});

export const secretsRoutes = new Hono<ControlPlaneHonoEnv>();

secretsRoutes.put("/repos/:owner/:name/secrets", REPO_SECRETS_MANAGE, (c) =>
  dispatch(c, handleSetRepoSecrets)
);
secretsRoutes.get("/repos/:owner/:name/secrets", REPO_SECRETS_MANAGE, (c) =>
  dispatch(c, handleListRepoSecrets)
);
secretsRoutes.delete("/repos/:owner/:name/secrets/:key", REPO_SECRETS_MANAGE, (c) =>
  dispatch(c, handleDeleteRepoSecret)
);
secretsRoutes.put("/secrets", GLOBAL_SECRETS_MANAGE, (c) => dispatch(c, handleSetGlobalSecrets));
secretsRoutes.get("/secrets", GLOBAL_SECRETS_MANAGE, (c) => dispatch(c, handleListGlobalSecrets));
secretsRoutes.delete("/secrets/:key", GLOBAL_SECRETS_MANAGE, (c) =>
  dispatch(c, handleDeleteGlobalSecret)
);
