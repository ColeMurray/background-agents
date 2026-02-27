/**
 * Repo image build routes.
 *
 * Handles:
 * - Build callbacks from Modal async builder (build-complete, build-failed)
 * - Manual build triggers
 * - Image build status queries
 * - Maintenance operations (stale builds, cleanup)
 */

import { RepoImageStore } from "../db/repo-images";
import { RepoMetadataStore } from "../db/repo-metadata";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createModalClient } from "../sandbox/client";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  createRouteSourceControlProvider,
  resolveInstalledRepo,
} from "./shared";

const logger = createLogger("router:repo-images");

/**
 * POST /repo-images/build-complete
 * Callback from Modal async builder on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: {
    build_id?: string;
    provider_image_id?: string;
    base_sha?: string;
    build_duration_seconds?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  const buildId = body.build_id;
  const providerImageId = body.provider_image_id;
  const baseSha = body.base_sha;
  const buildDurationSeconds = body.build_duration_seconds;

  if (!buildId || !providerImageId) {
    return error("build_id and provider_image_id are required", 400);
  }

  const store = new RepoImageStore(env.DB);

  try {
    const result = await store.markReady(
      buildId,
      providerImageId,
      baseSha || "",
      buildDurationSeconds ?? 0
    );

    logger.info("repo_image.build_complete", {
      build_id: buildId,
      provider_image_id: providerImageId,
      base_sha: baseSha,
      replaced_image_id: result.replacedImageId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    // Fire-and-forget: delete the replaced provider image if one was replaced
    if (result.replacedImageId && env.MODAL_API_SECRET && env.MODAL_WORKSPACE) {
      ctx.executionCtx?.waitUntil(
        (async () => {
          try {
            const client = createModalClient(env.MODAL_API_SECRET!, env.MODAL_WORKSPACE!);
            await client.deleteProviderImage({ providerImageId: result.replacedImageId! });
          } catch (e) {
            logger.warn("repo_image.delete_old_failed", {
              provider_image_id: result.replacedImageId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })()
      );
    }

    return json({ ok: true, replacedImageId: result.replacedImageId });
  } catch (e) {
    logger.error("repo_image.build_complete_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark build as ready", 500);
  }
}

/**
 * POST /repo-images/build-failed
 * Callback from Modal async builder on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { build_id?: string; error?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  const buildId = body.build_id;
  if (!buildId) {
    return error("build_id is required", 400);
  }

  const store = new RepoImageStore(env.DB);

  try {
    await store.markFailed(buildId, body.error || "Unknown error");

    logger.info("repo_image.build_failed", {
      build_id: buildId,
      error_message: body.error,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true });
  } catch (e) {
    logger.error("repo_image.build_failed_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark build as failed", 500);
  }
}

/**
 * POST /repo-images/trigger/:owner/:name
 * Manually trigger a build for a repo.
 */
async function handleTriggerBuild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    return error("Modal configuration not available", 503);
  }
  if (!env.WORKER_URL) {
    return error("WORKER_URL not configured", 503);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required", 400);
  }

  const store = new RepoImageStore(env.DB);
  const now = Date.now();
  const buildId = `img-${owner}-${name}-${now}`;

  try {
    // Register the build in D1
    await store.registerBuild({
      id: buildId,
      repoOwner: owner,
      repoName: name,
      baseBranch: "main",
    });

    // Construct callback URL
    const callbackUrl = `${env.WORKER_URL}/repo-images/build-complete`;

    // Best-effort: fetch user secrets for the build sandbox
    let userEnvVars: Record<string, string> | undefined;
    if (env.REPO_SECRETS_ENCRYPTION_KEY) {
      let globalSecrets: Record<string, string> = {};
      try {
        const globalStore = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
        globalSecrets = await globalStore.getDecryptedSecrets();
      } catch (e) {
        logger.warn("repo_image.global_secrets_failed", {
          error: e instanceof Error ? e.message : String(e),
          repo_owner: owner,
          repo_name: name,
        });
      }

      let repoSecrets: Record<string, string> = {};
      try {
        const provider = createRouteSourceControlProvider(env);
        const resolved = await resolveInstalledRepo(provider, owner, name);
        if (resolved) {
          const repoStore = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
          repoSecrets = await repoStore.getDecryptedSecrets(resolved.repoId);
        }
      } catch (e) {
        logger.warn("repo_image.repo_secrets_failed", {
          error: e instanceof Error ? e.message : String(e),
          repo_owner: owner,
          repo_name: name,
        });
      }

      const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
      if (Object.keys(merged).length > 0) {
        userEnvVars = merged;
        const logLevel = exceedsLimit ? "warn" : "info";
        logger[logLevel]("repo_image.secrets_loaded", {
          global_count: Object.keys(globalSecrets).length,
          repo_count: Object.keys(repoSecrets).length,
          merged_count: Object.keys(merged).length,
          payload_bytes: totalBytes,
          exceeds_limit: exceedsLimit,
          repo_owner: owner,
          repo_name: name,
        });
      }
    }

    // Trigger build on Modal
    const client = createModalClient(env.MODAL_API_SECRET, env.MODAL_WORKSPACE);
    await client.buildRepoImage(
      {
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
        buildId,
        callbackUrl,
        userEnvVars,
      },
      { trace_id: ctx.trace_id, request_id: ctx.request_id }
    );

    logger.info("repo_image.build_triggered", {
      build_id: buildId,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ buildId, status: "building" });
  } catch (e) {
    logger.error("repo_image.trigger_error", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to trigger build", 500);
  }
}

/**
 * GET /repo-images/status
 * Get image build status for all repos or a specific repo.
 */
async function handleGetStatus(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const url = new URL(request.url);
  const repoOwner = url.searchParams.get("repo_owner");
  const repoName = url.searchParams.get("repo_name");

  const store = new RepoImageStore(env.DB);

  try {
    if (repoOwner && repoName) {
      const images = await store.getStatus(repoOwner, repoName);
      return json({ images });
    }

    // Return all status (for scheduler use)
    const images = await store.getAllStatus();
    return json({ images });
  } catch (e) {
    logger.error("repo_image.status_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get image status", 500);
  }
}

/**
 * POST /repo-images/mark-stale
 * Mark old building rows as failed. Called by scheduler.
 */
async function handleMarkStale(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { max_age_seconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const maxAgeSeconds = body.max_age_seconds ?? 2100; // 35 minutes default
  const maxAgeMs = maxAgeSeconds * 1000;

  const store = new RepoImageStore(env.DB);

  try {
    const count = await store.markStaleBuildsAsFailed(maxAgeMs);

    logger.info("repo_image.stale_marked", {
      count,
      max_age_seconds: maxAgeSeconds,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, markedFailed: count });
  } catch (e) {
    logger.error("repo_image.mark_stale_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark stale builds", 500);
  }
}

/**
 * POST /repo-images/cleanup
 * Delete old failed builds. Called by scheduler.
 */
async function handleCleanup(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { max_age_seconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const maxAgeSeconds = body.max_age_seconds ?? 86400; // 24 hours default
  const maxAgeMs = maxAgeSeconds * 1000;

  const store = new RepoImageStore(env.DB);

  try {
    const count = await store.deleteOldFailedBuilds(maxAgeMs);

    logger.info("repo_image.cleanup", {
      deleted: count,
      max_age_seconds: maxAgeSeconds,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, deleted: count });
  } catch (e) {
    logger.error("repo_image.cleanup_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to clean up old builds", 500);
  }
}

/**
 * PUT /repo-images/toggle/:owner/:name
 * Toggle image building for a repo.
 */
async function handleToggleImageBuild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required", 400);
  }

  let body: { enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (typeof body.enabled !== "boolean") {
    return error("enabled must be a boolean", 400);
  }

  const metadataStore = new RepoMetadataStore(env.DB);

  try {
    await metadataStore.setImageBuildEnabled(owner, name, body.enabled);

    logger.info("repo_image.toggle", {
      repo_owner: owner,
      repo_name: name,
      enabled: body.enabled,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, enabled: body.enabled });
  } catch (e) {
    logger.error("repo_image.toggle_error", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to toggle image build", 500);
  }
}

/**
 * GET /repo-images/enabled-repos
 * Returns repos with image building enabled. Called by scheduler.
 */
async function handleGetEnabledRepos(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const metadataStore = new RepoMetadataStore(env.DB);

  try {
    const repos = await metadataStore.getImageBuildEnabledRepos();
    return json({ repos });
  } catch (e) {
    logger.error("repo_image.enabled_repos_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get enabled repos", 500);
  }
}

export const repoImageRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/repo-images/build-complete"),
    handler: handleBuildComplete,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/build-failed"),
    handler: handleBuildFailed,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/trigger/:owner/:name"),
    handler: handleTriggerBuild,
  },
  {
    method: "GET",
    pattern: parsePattern("/repo-images/status"),
    handler: handleGetStatus,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repo-images/toggle/:owner/:name"),
    handler: handleToggleImageBuild,
  },
  {
    method: "GET",
    pattern: parsePattern("/repo-images/enabled-repos"),
    handler: handleGetEnabledRepos,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/mark-stale"),
    handler: handleMarkStale,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/cleanup"),
    handler: handleCleanup,
  },
];
