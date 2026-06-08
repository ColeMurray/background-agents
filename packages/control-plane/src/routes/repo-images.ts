/**
 * Repo image build routes.
 *
 * Handles:
 * - Build callbacks from async repo image builders (build-complete, build-failed)
 * - Manual build triggers
 * - Image build status queries
 * - Maintenance operations (stale builds, cleanup)
 */

import { computeHmacHex } from "@open-inspect/shared";
import { RepoImageStore } from "../db/repo-images";
import { verifyInternalToken } from "../auth/internal";
import { RepoMetadataStore } from "../db/repo-metadata";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createModalClient } from "../sandbox/client";
import { createVercelSandboxClient } from "../sandbox/providers/vercel/client";
import { createVercelProvider } from "../sandbox/providers/vercel/provider";
import { resolveSandboxBackendName, supportsRepoImageBackend } from "../sandbox/provider-name";
import { resolveScmProviderFromEnv } from "../source-control";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  extractRepoParams,
  createRouteSourceControlProvider,
  resolveInstalledRepo,
} from "./shared";

const logger = createLogger("router:repo-images");
const VERCEL_CALLBACK_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const VERCEL_CALLBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function requireRepoImages(env: Env): Response | null {
  if (supportsRepoImageBackend(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return error("Repo images are only available when SANDBOX_PROVIDER=modal or vercel", 501);
}

function getRepoImageBackend(env: Env): "modal" | "vercel" {
  const backend = resolveSandboxBackendName(env.SANDBOX_PROVIDER);
  if (backend !== "modal" && backend !== "vercel") {
    throw new Error(`Repo images are not supported for SANDBOX_PROVIDER=${backend}`);
  }
  return backend;
}

async function requireBuildCallbackAuth(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    logger.error("repo_image.callback_auth_misconfigured", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Internal authentication not configured", 500);
  }

  const authorized = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!authorized) {
    logger.warn("repo_image.callback_auth_failed", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  return null;
}

function createConfiguredVercelProvider(env: Env) {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("Vercel configuration not available");
  }

  const client = createVercelSandboxClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
  });

  return createVercelProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
    baseSnapshotId: env.VERCEL_BASE_SNAPSHOT_ID,
    baseSnapshotName: env.VERCEL_BASE_SNAPSHOT_NAME,
    runtime: env.VERCEL_RUNTIME,
    snapshotExpirationMs: parseInt(env.VERCEL_SNAPSHOT_EXPIRATION_MS || "0", 10),
    codeServerPasswordSecret: env.VERCEL_TOKEN,
  });
}

function generateRepoImageCallbackToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashRepoImageCallbackToken(token: string, env: Env): Promise<string> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    throw new Error("INTERNAL_CALLBACK_SECRET is required for repo image callback hashing");
  }
  return computeHmacHex(`repo-image-callback:${token}`, env.INTERNAL_CALLBACK_SECRET);
}

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

function getVercelCallbackBearerToken(request: Request): string | null {
  const token = getBearerToken(request);
  if (!token || !VERCEL_CALLBACK_TOKEN_PATTERN.test(token)) return null;
  return token;
}

function requireVercelCallbackBearerAuth(request: Request, ctx: RequestContext): Response | null {
  if (getVercelCallbackBearerToken(request)) return null;

  logger.warn("repo_image.callback_auth_failed", {
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("Unauthorized", 401);
}

async function requireCallbackPreParseAuth(
  request: Request,
  env: Env,
  backend: "modal" | "vercel",
  ctx: RequestContext
): Promise<Response | null> {
  if (backend === "modal") {
    return requireBuildCallbackAuth(request, env, ctx);
  }

  return requireVercelCallbackBearerAuth(request, ctx);
}

async function requireVercelBuildCallbackAuth(
  request: Request,
  env: Env,
  store: RepoImageStore,
  params: { buildId: string; providerSessionId: string },
  ctx: RequestContext
): Promise<Response | null> {
  const token = getVercelCallbackBearerToken(request);
  if (!token) {
    logger.warn("repo_image.callback_auth_failed", {
      build_id: params.buildId,
      provider_session_id: params.providerSessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  let tokenHash: string;
  try {
    tokenHash = await hashRepoImageCallbackToken(token, env);
  } catch (e) {
    logger.error("repo_image.callback_auth_misconfigured", {
      build_id: params.buildId,
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Internal authentication not configured", 500);
  }

  const build = await store.consumeCallbackToken({
    buildId: params.buildId,
    provider: "vercel",
    providerSessionId: params.providerSessionId,
    tokenHash,
    now: Date.now(),
  });

  if (!build) {
    logger.warn("repo_image.callback_auth_failed", {
      build_id: params.buildId,
      provider_session_id: params.providerSessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  return null;
}

/**
 * POST /repo-images/build-complete
 * Callback from repo image builders on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const backend = getRepoImageBackend(env);
  const preParseAuthError = await requireCallbackPreParseAuth(request, env, backend, ctx);
  if (preParseAuthError) return preParseAuthError;

  const body = await parseJsonBody<{
    build_id?: string;
    provider_image_id?: string;
    provider_session_id?: string;
    base_sha?: string;
    build_duration_seconds?: number;
  }>(request);
  if (body instanceof Response) return body;

  const buildId = body.build_id;
  const providerImageId = body.provider_image_id;
  const providerSessionId = body.provider_session_id;
  const baseSha = body.base_sha;
  const buildDurationSeconds = body.build_duration_seconds;

  if (!buildId) {
    return error("build_id is required", 400);
  }

  const store = new RepoImageStore(env.DB);

  if (backend === "vercel") {
    if (!providerSessionId) {
      return error("provider_session_id is required", 400);
    }

    const authError = await requireVercelBuildCallbackAuth(
      request,
      env,
      store,
      { buildId, providerSessionId },
      ctx
    );
    if (authError) return authError;

    logger.info("repo_image.build_complete_received", {
      build_id: buildId,
      provider_session_id: providerSessionId,
      base_sha: baseSha,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    const completion = completeVercelBuildFromSession(env, {
      buildId,
      providerSessionId,
      baseSha: baseSha || "",
      buildDurationSeconds: buildDurationSeconds ?? 0,
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    });

    if (ctx.executionCtx) {
      ctx.executionCtx.waitUntil(completion);
    } else {
      await completion;
    }

    return json({ ok: true, snapshotPending: true });
  }

  if (!providerImageId) {
    return error("provider_image_id is required", 400);
  }

  try {
    const result = await store.markReady(
      buildId,
      backend,
      providerImageId,
      baseSha || "",
      buildDurationSeconds ?? 0
    );
    if (!result.updated) {
      return error("Build is not accepting completion", 409);
    }

    logger.info("repo_image.build_complete", {
      build_id: buildId,
      provider_image_id: providerImageId,
      base_sha: baseSha,
      replaced_image_id: result.replacedImageId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    // Fire-and-forget: delete the replaced provider image if one was replaced.
    if (result.replacedImageId) {
      ctx.executionCtx?.waitUntil(
        (async () => {
          try {
            if (getRepoImageBackend(env) === "vercel") {
              await createConfiguredVercelProvider(env).deleteProviderImage(
                result.replacedImageId!
              );
            } else if (env.MODAL_API_SECRET && env.MODAL_WORKSPACE) {
              const client = createModalClient(
                env.MODAL_API_SECRET,
                env.MODAL_WORKSPACE,
                env.MODAL_ENVIRONMENT_WEB_SUFFIX
              );
              await client.deleteProviderImage({ providerImageId: result.replacedImageId! });
            }
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

async function completeVercelBuildFromSession(
  env: Env,
  params: {
    buildId: string;
    providerSessionId: string;
    baseSha: string;
    buildDurationSeconds: number;
    requestId: string;
    traceId: string;
  }
): Promise<void> {
  if (!env.DB) {
    logger.error("repo_image.vercel_snapshot_error", {
      build_id: params.buildId,
      provider_session_id: params.providerSessionId,
      error: "Database not configured",
      request_id: params.requestId,
      trace_id: params.traceId,
    });
    return;
  }

  const snapshotStart = Date.now();
  const store = new RepoImageStore(env.DB);
  let vercelProvider: ReturnType<typeof createConfiguredVercelProvider> | null = null;

  try {
    logger.info("repo_image.vercel_snapshot_start", {
      build_id: params.buildId,
      provider_session_id: params.providerSessionId,
      request_id: params.requestId,
      trace_id: params.traceId,
    });

    vercelProvider = createConfiguredVercelProvider(env);
    const snapshot = await vercelProvider.takeSnapshot({
      providerObjectId: params.providerSessionId,
      sessionId: params.buildId,
      reason: "repo_image_build",
      correlation: {
        request_id: params.requestId,
        trace_id: params.traceId,
        sandbox_id: params.providerSessionId,
      },
    });

    if (!snapshot.success || !snapshot.imageId) {
      const message = snapshot.error || "Vercel snapshot did not return an image id";
      await store.markFailed(params.buildId, "vercel", message);
      logger.error("repo_image.vercel_snapshot_failed", {
        build_id: params.buildId,
        provider_session_id: params.providerSessionId,
        error: message,
        duration_ms: Date.now() - snapshotStart,
        request_id: params.requestId,
        trace_id: params.traceId,
      });
      return;
    }

    const result = await store.markReady(
      params.buildId,
      "vercel",
      snapshot.imageId,
      params.baseSha,
      params.buildDurationSeconds
    );
    if (!result.updated) {
      logger.warn("repo_image.vercel_snapshot_not_applied", {
        build_id: params.buildId,
        provider_session_id: params.providerSessionId,
        provider_image_id: snapshot.imageId,
        duration_ms: Date.now() - snapshotStart,
        request_id: params.requestId,
        trace_id: params.traceId,
      });
      return;
    }

    logger.info("repo_image.build_complete", {
      build_id: params.buildId,
      provider_image_id: snapshot.imageId,
      provider_session_id: params.providerSessionId,
      base_sha: params.baseSha,
      replaced_image_id: result.replacedImageId,
      snapshot_duration_ms: Date.now() - snapshotStart,
      request_id: params.requestId,
      trace_id: params.traceId,
    });

    if (result.replacedImageId) {
      try {
        await vercelProvider.deleteProviderImage(result.replacedImageId);
      } catch (e) {
        logger.warn("repo_image.delete_old_failed", {
          provider_image_id: result.replacedImageId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await store.markFailed(params.buildId, "vercel", message);
    } catch (markFailedError) {
      logger.error("repo_image.mark_failed_after_snapshot_error", {
        build_id: params.buildId,
        error: markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
        request_id: params.requestId,
        trace_id: params.traceId,
      });
    }
    logger.error("repo_image.vercel_snapshot_error", {
      build_id: params.buildId,
      provider_session_id: params.providerSessionId,
      error: message,
      duration_ms: Date.now() - snapshotStart,
      request_id: params.requestId,
      trace_id: params.traceId,
    });
  } finally {
    if (vercelProvider) {
      try {
        const stopResult = await vercelProvider.stopSandbox({
          providerObjectId: params.providerSessionId,
          sessionId: params.buildId,
          reason: "repo_image_build_complete",
          correlation: {
            request_id: params.requestId,
            trace_id: params.traceId,
            sandbox_id: params.providerSessionId,
          },
        });
        if (!stopResult.success) {
          logger.warn("repo_image.vercel_build_stop_failed", {
            build_id: params.buildId,
            provider_session_id: params.providerSessionId,
            error: stopResult.error,
            request_id: params.requestId,
            trace_id: params.traceId,
          });
        }
      } catch (stopError) {
        logger.warn("repo_image.vercel_build_stop_failed", {
          build_id: params.buildId,
          provider_session_id: params.providerSessionId,
          error: stopError instanceof Error ? stopError.message : String(stopError),
          request_id: params.requestId,
          trace_id: params.traceId,
        });
      }
    }
  }
}

/**
 * POST /repo-images/build-failed
 * Callback from repo image builders on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const backend = getRepoImageBackend(env);
  const preParseAuthError = await requireCallbackPreParseAuth(request, env, backend, ctx);
  if (preParseAuthError) return preParseAuthError;

  const body = await parseJsonBody<{
    build_id?: string;
    provider_session_id?: string;
    error?: string;
  }>(request);
  if (body instanceof Response) return body;

  const buildId = body.build_id;
  if (!buildId) {
    return error("build_id is required", 400);
  }

  const store = new RepoImageStore(env.DB);

  if (backend === "vercel") {
    if (!body.provider_session_id) {
      return error("provider_session_id is required", 400);
    }

    const authError = await requireVercelBuildCallbackAuth(
      request,
      env,
      store,
      { buildId, providerSessionId: body.provider_session_id },
      ctx
    );
    if (authError) return authError;
  }

  try {
    const updated = await store.markFailed(buildId, backend, body.error || "Unknown error");
    if (!updated) {
      return error("Build is not accepting failure", 409);
    }

    logger.info("repo_image.build_failed", {
      build_id: buildId,
      error_message: body.error,
      provider_session_id: body.provider_session_id,
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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }
  if (!env.WORKER_URL) {
    return error("WORKER_URL not configured", 503);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const store = new RepoImageStore(env.DB);
  const backend = getRepoImageBackend(env);
  const now = Date.now();
  const buildId = `img-${owner}-${name}-${now}`;

  try {
    const callbackToken = backend === "vercel" ? generateRepoImageCallbackToken() : undefined;
    const callbackTokenHash = callbackToken
      ? await hashRepoImageCallbackToken(callbackToken, env)
      : undefined;

    // Register the build in D1
    await store.registerBuild({
      id: buildId,
      repoOwner: owner,
      repoName: name,
      provider: backend,
      baseBranch: "main",
      callbackTokenHash,
      callbackTokenExpiresAt: callbackToken ? now + VERCEL_CALLBACK_TOKEN_TTL_MS : undefined,
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

    switch (backend) {
      case "modal": {
        if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
          return error("Modal configuration not available", 503);
        }
        const client = createModalClient(
          env.MODAL_API_SECRET,
          env.MODAL_WORKSPACE,
          env.MODAL_ENVIRONMENT_WEB_SUFFIX
        );
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
        break;
      }
      case "vercel": {
        if (!callbackToken) {
          throw new Error("Vercel callback token was not generated");
        }

        let cloneToken: string | undefined;
        try {
          const provider = createRouteSourceControlProvider(env);
          const auth = await provider.generateCredentialHelperAuth();
          cloneToken = auth.password;
        } catch (e) {
          logger.warn("repo_image.clone_token_failed", {
            error: e instanceof Error ? e.message : String(e),
            repo_owner: owner,
            repo_name: name,
          });
        }
        await createConfiguredVercelProvider(env).triggerRepoImageBuild({
          repoOwner: owner,
          repoName: name,
          defaultBranch: "main",
          buildId,
          callbackUrl,
          callbackToken,
          userEnvVars,
          cloneToken,
          onProviderSessionCreated: async (providerSessionId) => {
            const bound = await store.bindProviderSession(buildId, "vercel", providerSessionId);
            if (!bound) {
              throw new Error("Failed to bind Vercel build session");
            }
          },
          correlation: { trace_id: ctx.trace_id, request_id: ctx.request_id },
        });
        break;
      }
      default: {
        const unsupportedBackend: never = backend;
        return error(`Repo image builds are not supported for provider ${unsupportedBackend}`, 501);
      }
    }

    logger.info("repo_image.build_triggered", {
      build_id: buildId,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ buildId, status: "building" });
  } catch (e) {
    try {
      await store.markFailed(buildId, backend, e instanceof Error ? e.message : String(e));
    } catch (markFailedError) {
      logger.warn("repo_image.trigger_mark_failed_error", {
        error: markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
        build_id: buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }

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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const body = await parseJsonBody<{ enabled?: unknown }>(request);
  if (body instanceof Response) return body;

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
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

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
