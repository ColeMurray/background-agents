/**
 * Repository and global secrets routes and handlers.
 */

import { RepoSecretsStore } from "../db/repo-secrets";
import { GlobalSecretsStore } from "../db/global-secrets";
import { SecretsValidationError, normalizeKey, validateKey } from "../db/secrets-validation";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  resolveInstalledRepo,
} from "./shared";

const logger = createLogger("router:secrets");

/**
 * Upsert secrets for a repository.
 */
async function handleSetRepoSecrets(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  let body: { secrets?: Record<string, string> };
  try {
    body = (await request.json()) as { secrets?: Record<string, string> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets list", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
  const globalStore = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  const key = match.groups?.key;
  if (!owner || !name || !key) {
    return error("Owner, name, and key are required");
  }

  let resolved;
  try {
    resolved = await resolveInstalledRepo(env, owner, name);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository for secrets delete", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error(
      message === "GitHub App not configured" ? message : "Failed to resolve repository",
      500
    );
  }

  const store = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  let body: { secrets?: Record<string, string> };
  try {
    body = (await request.json()) as { secrets?: Record<string, string> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.secrets || typeof body.secrets !== "object") {
    return error("Request body must include secrets object", 400);
  }

  const store = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const store = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Secrets storage is not configured", 503);
  }
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return error("REPO_SECRETS_ENCRYPTION_KEY not configured", 500);
  }

  const key = match.groups?.key;
  if (!key) {
    return error("Key is required");
  }

  const store = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);

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

export const secretsRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleSetRepoSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/repos/:owner/:name/secrets"),
    handler: handleListRepoSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/repos/:owner/:name/secrets/:key"),
    handler: handleDeleteRepoSecret,
  },
  {
    method: "PUT",
    pattern: parsePattern("/secrets"),
    handler: handleSetGlobalSecrets,
  },
  {
    method: "GET",
    pattern: parsePattern("/secrets"),
    handler: handleListGlobalSecrets,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/secrets/:key"),
    handler: handleDeleteGlobalSecret,
  },
];
