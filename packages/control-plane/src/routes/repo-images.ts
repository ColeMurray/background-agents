/**
 * Repo image build routes.
 *
 * Handles:
 * - Build callbacks from async repo image builders (build-complete, build-failed)
 * - Manual build triggers
 * - Image build status queries
 * - Maintenance operations (stale builds, cleanup)
 */

import { RepoImageStore, type RepoImageProvider } from "../db/repo-images";
import { RepoMetadataStore } from "../db/repo-metadata";
import { createLogger } from "../logger";
import {
  getRepoImageBackend,
  getRepoImageCallbackMode,
  getRepoImagesUnsupportedMessage,
} from "../repo-images/backend-policy";
import { createRepoImageBuildWorkflowFromEnv } from "../repo-images/workflow";
import type {
  CompleteRepoImageBuild,
  FailRepoImageBuild,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
} from "../repo-images/types";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  error,
  extractRepoParams,
  json,
  parseJsonBody,
  parsePattern,
} from "./shared";
import {
  getRepoImageCallbackBearerToken,
  requireCallbackPreParseGate,
} from "./repo-image-callback-auth";

const logger = createLogger("router:repo-images");
const MS_PER_SECOND = 1000;
const DEFAULT_STALE_BUILD_MAX_AGE_MS = 4200 * MS_PER_SECOND;
const DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS = 86400 * MS_PER_SECOND;

interface RepoImageBuildCompleteBody {
  build_id?: unknown;
  provider_image_id?: unknown;
  provider_session_id?: unknown;
  base_sha?: unknown;
  build_duration_seconds?: unknown;
}

interface RepoImageBuildFailedBody {
  build_id?: unknown;
  provider_session_id?: unknown;
  error?: unknown;
}

function requireRepoImages(env: Env): Response | null {
  const message = getRepoImagesUnsupportedMessage(env);
  return message ? error(message, 501) : null;
}

function workflowContext(ctx: RequestContext): RepoImageWorkflowContext {
  return {
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
}

async function workflowResultToResponse(
  result: RepoImageWorkflowResult,
  ctx: RequestContext
): Promise<Response> {
  if (result.type === "completion_accepted") {
    await scheduleWorkflowTask(result.finalization, ctx);
  } else if ((result.type === "build_ready" || result.type === "build_failed") && result.cleanup) {
    await scheduleWorkflowTask(result.cleanup, ctx);
  }

  switch (result.type) {
    case "build_triggered":
      return json({ buildId: result.buildId, status: "building" });
    case "completion_accepted":
      return json({ ok: true, snapshotPending: true });
    case "build_ready":
      return json({
        ok: true,
        replacedImageId: result.replacedImages[0]?.providerImageId ?? null,
      });
    case "build_failed":
      return json({ ok: true });
    case "callback_auth_rejected":
      return error(result.message, 401);
    case "callback_auth_unavailable":
      return error(result.message, 500);
    case "repository_not_installed":
      return error(result.message, 404);
    case "repo_image_workflow_unavailable":
    case "repo_image_provider_unconfigured":
      return error(result.message, 503);
    case "completion_not_accepted":
    case "failure_not_accepted":
      return error(result.message, 409);
    case "workflow_failed":
      return error(result.message, 500);
    default: {
      const exhaustive: never = result;
      return error(`Unhandled workflow result: ${String(exhaustive)}`, 500);
    }
  }
}

async function scheduleWorkflowTask(task: Promise<void>, ctx: RequestContext): Promise<void> {
  if (ctx.executionCtx) {
    ctx.executionCtx.waitUntil(task);
    return;
  }

  await task;
}

function requireStringField(value: unknown, field: string): string | Response {
  return typeof value === "string" && value.length > 0 ? value : error(`${field} is required`, 400);
}

function requireNumberField(value: unknown, field: string): number | Response {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : error(`${field} is required`, 400);
}

function optionalStringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function buildCompleteCommand(
  body: RepoImageBuildCompleteBody,
  backend: RepoImageProvider
): CompleteRepoImageBuild | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  const baseSha = requireStringField(body.base_sha, "base_sha");
  if (baseSha instanceof Response) return baseSha;

  const buildDurationSeconds = requireNumberField(
    body.build_duration_seconds,
    "build_duration_seconds"
  );
  if (buildDurationSeconds instanceof Response) return buildDurationSeconds;
  const buildDurationMs = buildDurationSeconds * MS_PER_SECOND;

  if (getRepoImageCallbackMode(backend) === "provider_session") {
    const providerSessionId = requireStringField(body.provider_session_id, "provider_session_id");
    if (providerSessionId instanceof Response) return providerSessionId;
    return {
      kind: "provider_session",
      buildId,
      providerSessionId,
      baseSha,
      buildDurationMs,
    };
  }

  const providerImageId = requireStringField(body.provider_image_id, "provider_image_id");
  if (providerImageId instanceof Response) return providerImageId;
  return {
    kind: "provider_image",
    buildId,
    providerImageId,
    baseSha,
    buildDurationMs,
  };
}

function buildFailedCommand(
  body: RepoImageBuildFailedBody,
  backend: RepoImageProvider
): FailRepoImageBuild | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  const errorMessage = optionalStringField(body.error, "Unknown error");

  if (getRepoImageCallbackMode(backend) === "provider_session") {
    const providerSessionId = requireStringField(body.provider_session_id, "provider_session_id");
    if (providerSessionId instanceof Response) return providerSessionId;
    return {
      kind: "provider_session",
      buildId,
      providerSessionId,
      errorMessage,
    };
  }

  return {
    kind: "provider_image",
    buildId,
    errorMessage,
  };
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
  const preParseAuthError = await requireCallbackPreParseGate(request, env, backend, ctx, logger);
  if (preParseAuthError) return preParseAuthError;

  const body = await parseJsonBody<RepoImageBuildCompleteBody>(request);
  if (body instanceof Response) return body;

  const completion = buildCompleteCommand(body, backend);
  if (completion instanceof Response) return completion;

  const result = await createRepoImageBuildWorkflowFromEnv(env).acceptBuildComplete({
    completion,
    callbackToken: getRepoImageCallbackBearerToken(request),
    context: workflowContext(ctx),
  });
  return workflowResultToResponse(result, ctx);
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
  const preParseAuthError = await requireCallbackPreParseGate(request, env, backend, ctx, logger);
  if (preParseAuthError) return preParseAuthError;

  const body = await parseJsonBody<RepoImageBuildFailedBody>(request);
  if (body instanceof Response) return body;

  const failure = buildFailedCommand(body, backend);
  if (failure instanceof Response) return failure;

  const result = await createRepoImageBuildWorkflowFromEnv(env).acceptBuildFailed({
    failure,
    callbackToken: getRepoImageCallbackBearerToken(request),
    context: workflowContext(ctx),
  });
  return workflowResultToResponse(result, ctx);
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

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;

  const result = await createRepoImageBuildWorkflowFromEnv(env).triggerBuild(
    params.owner,
    params.name,
    workflowContext(ctx)
  );
  return workflowResultToResponse(result, ctx);
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

  const maxAgeMs =
    body.max_age_seconds === undefined
      ? DEFAULT_STALE_BUILD_MAX_AGE_MS
      : body.max_age_seconds * MS_PER_SECOND;
  const maxAgeSeconds = maxAgeMs / MS_PER_SECOND;

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

  const maxAgeMs =
    body.max_age_seconds === undefined
      ? DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS
      : body.max_age_seconds * MS_PER_SECOND;
  const maxAgeSeconds = maxAgeMs / MS_PER_SECOND;

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
