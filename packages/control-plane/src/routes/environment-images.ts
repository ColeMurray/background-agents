/**
 * Environment image build routes (design §7.3).
 *
 * Handles:
 * - Build callbacks from async environment image builders (build-complete, build-failed)
 * - Build triggers (cron pass, save-hooks, manual rebuild)
 * - Enabled-environments and status queries for the rebuild cron
 * - Maintenance operations (stale builds, cleanup + superseded-artifact reaping)
 */

import { EnvironmentImageStore } from "../db/environment-images";
import { EnvironmentStore } from "../db/environments";
import { createLogger } from "../logger";
import { EnvironmentImageError } from "../environment-images/errors";
import { computeRepositoriesFingerprint } from "../environment-images/fingerprint";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  type EnvironmentImageRepositorySha,
} from "../environment-images/model";
import { createEnvironmentImageBuildWorkflowFromEnv } from "../environment-images/workflow";
import type {
  CompleteEnvironmentImageBuildCallback,
  EnvironmentImageWorkflowContext,
  EnvironmentImageWorkflowResult,
  FailEnvironmentImageBuildCallback,
} from "../environment-images/types";
import { getRepoImagesUnsupportedMessage } from "../repo-images/provider-policy";
import type { Env } from "../types";
import { getRepoImageCallbackBearerToken } from "./repo-image-callback-auth";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

const logger = createLogger("router:environment-images");
const MS_PER_SECOND = 1000;
const MAX_CALLBACK_BODY_BYTES = 16 * 1024;
const DEFAULT_STALE_BUILD_MAX_AGE_MS = 4200 * MS_PER_SECOND;
const DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS = 86400 * MS_PER_SECOND;

interface EnvironmentImageBuildCompleteBody {
  build_id?: unknown;
  provider_image_id?: unknown;
  provider_session_id?: unknown;
  repository_shas?: unknown;
  runtime_version?: unknown;
  build_duration_seconds?: unknown;
}

interface EnvironmentImageBuildFailedBody {
  build_id?: unknown;
  provider_session_id?: unknown;
  error?: unknown;
}

function requireEnvironmentImages(env: Env): Response | null {
  // Environment images run on the repo-image provider set (design §7.3).
  const message = getRepoImagesUnsupportedMessage(env);
  return message ? error(message, 501) : null;
}

function requireDb(env: Env): Response | null {
  return env.DB ? null : error("Database not configured", 503);
}

function workflowContext(ctx: RequestContext): EnvironmentImageWorkflowContext {
  return {
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
}

async function workflowResultToResponse(
  result: EnvironmentImageWorkflowResult,
  ctx: RequestContext
): Promise<Response> {
  if (result.type === "completion_accepted") {
    await scheduleWorkflowTask(result.finalization, ctx);
  } else if (result.cleanup) {
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

function environmentImageErrorToResponse(errorValue: unknown): Response {
  if (!(errorValue instanceof EnvironmentImageError)) throw errorValue;

  switch (errorValue.code) {
    case "environment_not_found":
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
      return error(`Unhandled environment image error: ${String(exhaustive)}`, 500);
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

async function parseCallbackBody<T>(request: Request): Promise<T | Response> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_CALLBACK_BODY_BYTES) {
    return error("Payload too large", 413);
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
  if (bodyBytes > MAX_CALLBACK_BODY_BYTES) {
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

function requireStringField(value: unknown, field: string): string | Response {
  return typeof value === "string" && value.length > 0 ? value : error(`${field} is required`, 400);
}

function optionalStringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Parse the repository_shas document ([{repoOwner, repoName, baseSha}], the
 * single cross-language shape produced by the runtime). Malformed entries are
 * a 400 — deeper requirements (non-empty) are the workflow's fail-close.
 */
function parseRepositoryShas(
  value: unknown
): EnvironmentImageRepositorySha[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return error("repository_shas must be an array", 400);

  const shas: EnvironmentImageRepositorySha[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return error("repository_shas entries must be objects", 400);
    }
    const { repoOwner, repoName, baseSha } = entry as Record<string, unknown>;
    if (
      typeof repoOwner !== "string" ||
      repoOwner.length === 0 ||
      typeof repoName !== "string" ||
      repoName.length === 0 ||
      typeof baseSha !== "string" ||
      baseSha.length === 0
    ) {
      return error("repository_shas entries require repoOwner, repoName, and baseSha", 400);
    }
    shas.push({ repoOwner, repoName, baseSha });
  }
  return shas;
}

function buildCompleteCommand(
  body: EnvironmentImageBuildCompleteBody
): CompleteEnvironmentImageBuildCallback | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  let buildDurationMs: number | undefined;
  if (body.build_duration_seconds !== undefined) {
    if (typeof body.build_duration_seconds !== "number") {
      return error("build_duration_seconds is required", 400);
    }
    buildDurationMs = body.build_duration_seconds * MS_PER_SECOND;
  }

  const repositoryShas = parseRepositoryShas(body.repository_shas);
  if (repositoryShas instanceof Response) return repositoryShas;

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
    repositoryShas,
    runtimeVersion:
      typeof body.runtime_version === "string" && body.runtime_version.length > 0
        ? body.runtime_version
        : undefined,
    buildDurationMs,
  };
}

function buildFailedCommand(
  body: EnvironmentImageBuildFailedBody
): FailEnvironmentImageBuildCallback | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  return {
    buildId,
    providerSessionId:
      typeof body.provider_session_id === "string" && body.provider_session_id.length > 0
        ? body.provider_session_id
        : undefined,
    errorMessage: optionalStringField(body.error, "Unknown error"),
  };
}

/**
 * POST /environment-images/build-complete
 * Callback from environment image builders on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const body = await parseCallbackBody<EnvironmentImageBuildCompleteBody>(request);
  if (body instanceof Response) return body;

  const completion = buildCompleteCommand(body);
  if (completion instanceof Response) return completion;

  try {
    const result = await createEnvironmentImageBuildWorkflowFromEnv(env).acceptBuildComplete({
      completion,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getRepoImageCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return environmentImageErrorToResponse(e);
  }
}

/**
 * POST /environment-images/build-failed
 * Callback from environment image builders on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const dbError = requireDb(env);
  if (dbError) return dbError;

  const body = await parseCallbackBody<EnvironmentImageBuildFailedBody>(request);
  if (body instanceof Response) return body;

  const failure = buildFailedCommand(body);
  if (failure instanceof Response) return failure;

  try {
    const result = await createEnvironmentImageBuildWorkflowFromEnv(env).acceptBuildFailed({
      failure,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getRepoImageCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return environmentImageErrorToResponse(e);
  }
}

/**
 * POST /environment-images/trigger/:id
 * Trigger a build for an environment (cron, save-hooks, manual rebuild).
 */
async function handleTriggerBuild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireEnvironmentImages(env);
  if (providerError) return providerError;

  const dbError = requireDb(env);
  if (dbError) return dbError;

  const environmentId = match.groups?.id;
  if (!environmentId) return error("Environment ID required", 400);

  try {
    const result = await createEnvironmentImageBuildWorkflowFromEnv(env).triggerBuild(
      environmentId,
      workflowContext(ctx)
    );
    if (result.type === "up_to_date") {
      // Unreachable via this route (triggerBuild is unconditional); guards
      // the union exhaustively.
      return json({ ok: true, upToDate: true });
    }
    return json({
      buildId: result.buildId,
      status: "building",
      alreadyBuilding: result.type === "already_building",
    });
  } catch (e) {
    return environmentImageErrorToResponse(e);
  }
}

/**
 * GET /environment-images/status[?environment_id=...]
 * Image rows (non-superseded) for the cron and the settings UI. Rows are
 * returned verbatim (snake_case columns; repository_shas is a JSON document).
 */
async function handleGetStatus(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireEnvironmentImages(env);
  if (providerError) return providerError;

  const dbError = requireDb(env);
  if (dbError) return dbError;

  const environmentId = new URL(request.url).searchParams.get("environment_id");
  const store = new EnvironmentImageStore(env.DB);

  try {
    const images = environmentId
      ? await store.getStatus(environmentId)
      : await store.getAllStatus();
    return json({ images });
  } catch (e) {
    logger.error("environment_image.status_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get image status", 500);
  }
}

/**
 * GET /environment-images/enabled
 * Prebuild-enabled environments with their current repositories and fingerprint,
 * plus the runtime floor — everything the cron's trigger checks need, so the
 * fingerprint algorithm never leaves the control plane (design §7.3).
 */
async function handleGetEnabledEnvironments(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireEnvironmentImages(env);
  if (providerError) return providerError;

  const dbError = requireDb(env);
  if (dbError) return dbError;

  const store = new EnvironmentStore(env.DB);

  try {
    const { environments } = await store.list();
    const enabled = environments.filter((row) => row.prebuild_enabled === 1);
    const repositoriesById = await store.getRepositoriesForEnvironmentIds(
      enabled.map((row) => row.id)
    );

    const payload = await Promise.all(
      enabled.map(async (row) => {
        const repositories = (repositoriesById.get(row.id) ?? []).map((repo) => ({
          repoOwner: repo.repo_owner,
          repoName: repo.repo_name,
          baseBranch: repo.base_branch,
        }));
        return {
          id: row.id,
          name: row.name,
          repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
          repositories,
        };
      })
    );

    return json({
      environments: payload,
      minRuntimeVersion: MIN_COMPATIBLE_RUNTIME_VERSION,
    });
  } catch (e) {
    logger.error("environment_image.enabled_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get enabled environments", 500);
  }
}

/**
 * POST /environment-images/mark-stale
 * Mark old building rows as failed. Called by scheduler.
 */
async function handleMarkStale(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireEnvironmentImages(env);
  if (providerError) return providerError;

  const dbError = requireDb(env);
  if (dbError) return dbError;

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

  const store = new EnvironmentImageStore(env.DB);

  try {
    const count = await store.markStaleBuildsAsFailed(maxAgeMs);

    logger.info("environment_image.stale_marked", {
      count,
      max_age_seconds: maxAgeMs / MS_PER_SECOND,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, markedFailed: count });
  } catch (e) {
    logger.error("environment_image.mark_stale_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark stale builds", 500);
  }
}

/**
 * POST /environment-images/cleanup
 * Delete old failed builds and reap superseded rows' provider artifacts.
 * Called by scheduler.
 */
async function handleCleanup(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireEnvironmentImages(env);
  if (providerError) return providerError;

  const dbError = requireDb(env);
  if (dbError) return dbError;

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

  try {
    const result = await createEnvironmentImageBuildWorkflowFromEnv(env).cleanupImages(
      maxAgeMs,
      workflowContext(ctx)
    );

    logger.info("environment_image.cleanup", {
      deleted: result.deletedFailed,
      reaped_superseded: result.reapedSuperseded,
      max_age_seconds: maxAgeMs / MS_PER_SECOND,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      ok: true,
      deleted: result.deletedFailed,
      reapedSuperseded: result.reapedSuperseded,
    });
  } catch (e) {
    logger.error("environment_image.cleanup_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to clean up old builds", 500);
  }
}

export const environmentImageRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/environment-images/build-complete"),
    handler: handleBuildComplete,
  },
  {
    method: "POST",
    pattern: parsePattern("/environment-images/build-failed"),
    handler: handleBuildFailed,
  },
  {
    method: "POST",
    pattern: parsePattern("/environment-images/trigger/:id"),
    handler: handleTriggerBuild,
  },
  {
    method: "GET",
    pattern: parsePattern("/environment-images/status"),
    handler: handleGetStatus,
  },
  {
    method: "GET",
    pattern: parsePattern("/environment-images/enabled"),
    handler: handleGetEnabledEnvironments,
  },
  {
    method: "POST",
    pattern: parsePattern("/environment-images/mark-stale"),
    handler: handleMarkStale,
  },
  {
    method: "POST",
    pattern: parsePattern("/environment-images/cleanup"),
    handler: handleCleanup,
  },
];
