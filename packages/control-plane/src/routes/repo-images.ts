/**
 * Repo image build routes.
 *
 * Handles:
 * - Build callbacks from async repo image builders (build-complete, build-failed)
 * - Manual build triggers
 * - Image build status queries
 * - Maintenance operations (stale builds, cleanup)
 */

import { RepoImageStore } from "../db/repo-images";
import { RepoMetadataStore } from "../db/repo-metadata";
import { createLogger } from "../logger";
import { RepoImageError } from "../repo-images/errors";
import { getRepoImagesUnsupportedMessage } from "../repo-images/provider-policy";
import { createRepoImageBuildWorkflowFromEnv } from "../repo-images/workflow";
import type {
  CompleteRepoImageBuildCallback,
  FailRepoImageBuildCallback,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
} from "../repo-images/types";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS,
  DEFAULT_STALE_BUILD_MAX_AGE_MS,
  error,
  extractRepoParams,
  json,
  parseJsonBody,
  parseMaxAgeMs,
  parsePattern,
} from "./shared";
import { getRepoImageCallbackBearerToken } from "./repo-image-callback-auth";

const logger = createLogger("router:repo-images");
const MS_PER_SECOND = 1000;
const MAX_REPO_IMAGE_CALLBACK_BODY_BYTES = 16 * 1024;

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
  } else if (
    (result.type === "build_ready" ||
      result.type === "build_superseded" ||
      result.type === "build_failed") &&
    result.cleanup
  ) {
    await scheduleWorkflowTask(result.cleanup, ctx);
  }

  switch (result.type) {
    case "completion_accepted":
      return json({ ok: true, snapshotPending: true });
    case "build_ready":
      return json({
        ok: true,
        replacedImageId: result.replacedImages[0]?.image.providerImageId ?? null,
      });
    case "build_superseded":
      return json({ ok: true, superseded: true });
    case "build_failed":
      return json({ ok: true });
    default: {
      const exhaustive: never = result;
      return error(`Unhandled workflow result: ${String(exhaustive)}`, 500);
    }
  }
}

function repoImageErrorToResponse(errorValue: unknown): Response {
  if (!(errorValue instanceof RepoImageError)) throw errorValue;

  switch (errorValue.code) {
    case "repository_not_installed":
      return error(errorValue.message, 404);
    case "invalid_callback":
      return error(errorValue.message, 400);
    case "callback_auth_rejected":
      return error(errorValue.message, 401);
    case "completion_not_accepted":
    case "failure_not_accepted":
      return error(errorValue.message, 409);
    case "workflow_unavailable":
    case "provider_unconfigured":
      return error(errorValue.message, 503);
    case "planning_failed":
    case "trigger_failed":
    case "callback_auth_unavailable":
    case "build_complete_failed":
    case "build_failed_update_failed":
      return error(errorValue.message, 500);
    default: {
      const exhaustive: never = errorValue.code;
      return error(`Unhandled repo image error: ${String(exhaustive)}`, 500);
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

async function parseRepoImageCallbackBody<T>(request: Request): Promise<T | Response> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_REPO_IMAGE_CALLBACK_BODY_BYTES) {
    return error("Payload too large", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
  if (bodyBytes > MAX_REPO_IMAGE_CALLBACK_BODY_BYTES) {
    return error("Payload too large", 413);
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return error("Invalid JSON body", 400);
    }
    return parsed as T;
  } catch {
    return error("Invalid JSON body", 400);
  }
}

function buildCompleteCommand(
  body: RepoImageBuildCompleteBody
): CompleteRepoImageBuildCallback | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  let buildDurationMs: number | undefined;
  if (body.build_duration_seconds !== undefined) {
    const buildDurationSeconds = requireNumberField(
      body.build_duration_seconds,
      "build_duration_seconds"
    );
    if (buildDurationSeconds instanceof Response) return buildDurationSeconds;
    buildDurationMs = buildDurationSeconds * MS_PER_SECOND;
  }

  return {
    buildId,
    providerImageId:
      typeof body.provider_image_id === "string" && body.provider_image_id.length > 0
        ? body.provider_image_id
        : undefined,
    providerSessionId:
      typeof body.provider_session_id === "string" && body.provider_session_id.length > 0
        ? body.provider_session_id
        : undefined,
    baseSha:
      typeof body.base_sha === "string" && body.base_sha.length > 0 ? body.base_sha : undefined,
    buildDurationMs,
  };
}

function buildFailedCommand(body: RepoImageBuildFailedBody): FailRepoImageBuildCallback | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  const errorMessage = optionalStringField(body.error, "Unknown error");

  return {
    buildId,
    providerSessionId:
      typeof body.provider_session_id === "string" && body.provider_session_id.length > 0
        ? body.provider_session_id
        : undefined,
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
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const body = await parseRepoImageCallbackBody<RepoImageBuildCompleteBody>(request);
  if (body instanceof Response) return body;

  const completion = buildCompleteCommand(body);
  if (completion instanceof Response) return completion;

  try {
    const result = await createRepoImageBuildWorkflowFromEnv(env).acceptBuildComplete({
      completion,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getRepoImageCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return repoImageErrorToResponse(e);
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
  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const body = await parseRepoImageCallbackBody<RepoImageBuildFailedBody>(request);
  if (body instanceof Response) return body;

  const failure = buildFailedCommand(body);
  if (failure instanceof Response) return failure;

  try {
    const result = await createRepoImageBuildWorkflowFromEnv(env).acceptBuildFailed({
      failure,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getRepoImageCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return repoImageErrorToResponse(e);
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

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;

  try {
    const result = await createRepoImageBuildWorkflowFromEnv(env).triggerBuild(
      params.owner,
      params.name,
      workflowContext(ctx)
    );
    return json({ buildId: result.buildId, status: "building" });
  } catch (e) {
    return repoImageErrorToResponse(e);
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

  const maxAgeMs = await parseMaxAgeMs(request, DEFAULT_STALE_BUILD_MAX_AGE_MS);
  if (maxAgeMs instanceof Response) return maxAgeMs;
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

  const maxAgeMs = await parseMaxAgeMs(request, DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS);
  if (maxAgeMs instanceof Response) return maxAgeMs;
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
