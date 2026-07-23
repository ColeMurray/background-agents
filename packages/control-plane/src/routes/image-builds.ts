/**
 * Image build routes.
 *
 * Handles:
 * - Build callbacks from async image builders (build-complete, build-failed)
 * - Build triggers (cron pass, save-hooks, manual rebuild)
 * - The repo prebuild toggle (the repo_metadata flag write)
 * - Enabled-scope and status queries for the rebuild cron
 * - Maintenance operations (stale builds, cleanup + superseded-artifact reaping)
 */

import type { ImageBuildRecordView, RepositoryShaEntry } from "@open-inspect/shared";
import { ImageBuildStore } from "../db/image-builds";
import { RepoMetadataStore } from "../db/repo-metadata";
import { createLogger } from "../logger";
import { getImageBuildCallbackBearerToken } from "../image-builds/callback-auth";
import { ImageBuildError } from "../image-builds/errors";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "../image-builds/maintenance";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  repoImageBuildScope,
  type ImageBuildScope,
} from "../image-builds/model";
import { getImageBuildsUnsupportedMessage } from "../image-builds/provider-policy";
import { scheduleImageBuildOnSave } from "../image-builds/save-hooks";
import {
  listEnabledScopes,
  listEnabledScopeUnits,
  resolveScopeTarget,
} from "../image-builds/scope";
import { createImageBuildWorkflowFromEnv } from "../image-builds/workflow";
import type {
  CompleteImageBuildCallback,
  FailImageBuildCallback,
  ImageBuildWorkflowContext,
  ImageBuildWorkflowResult,
} from "../image-builds/types";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import {
  type RequestContext,
  type Route,
  error,
  extractRepoParams,
  json,
  parseJsonBody,
  parseMaxAgeMs,
  parsePattern,
} from "./shared";

const logger = createLogger("router:image-builds");
const MS_PER_SECOND = 1000;
const MAX_CALLBACK_BODY_BYTES = 16 * 1024;
const DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS = 86400 * MS_PER_SECOND;

interface ImageBuildCompleteBody {
  build_id?: unknown;
  provider_image_id?: unknown;
  provider_session_id?: unknown;
  repository_shas?: unknown;
  runtime_version?: unknown;
  build_duration_seconds?: unknown;
}

interface ImageBuildFailedBody {
  build_id?: unknown;
  provider_session_id?: unknown;
  error?: unknown;
}

function requireImageBuilds(env: Env): Response | null {
  const message = getImageBuildsUnsupportedMessage(env);
  return message ? error(message, 501) : null;
}

function workflowContext(ctx: RequestContext): ImageBuildWorkflowContext {
  return {
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
}

async function workflowResultToResponse(
  result: ImageBuildWorkflowResult,
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

function imageBuildErrorToResponse(errorValue: unknown): Response {
  if (!(errorValue instanceof ImageBuildError)) throw errorValue;

  switch (errorValue.code) {
    case "scope_not_found":
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
      return error(`Unhandled image build error: ${String(exhaustive)}`, 500);
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
function parseRepositoryShas(value: unknown): RepositoryShaEntry[] | undefined | Response {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return error("repository_shas must be an array", 400);

  const shas: RepositoryShaEntry[] = [];
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

function buildCompleteCommand(body: ImageBuildCompleteBody): CompleteImageBuildCallback | Response {
  const buildId = requireStringField(body.build_id, "build_id");
  if (buildId instanceof Response) return buildId;

  let buildDurationMs: number | undefined;
  if (body.build_duration_seconds !== undefined) {
    if (typeof body.build_duration_seconds !== "number") {
      return error("build_duration_seconds must be a number", 400);
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

function buildFailedCommand(body: ImageBuildFailedBody): FailImageBuildCallback | Response {
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
 * POST /image-builds/build-complete
 * Callback from image builders on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseCallbackBody<ImageBuildCompleteBody>(request);
  if (body instanceof Response) return body;

  const completion = buildCompleteCommand(body);
  if (completion instanceof Response) return completion;

  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).acceptBuildComplete({
      completion,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getImageBuildCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return imageBuildErrorToResponse(e);
  }
}

/**
 * POST /image-builds/build-failed
 * Callback from image builders on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseCallbackBody<ImageBuildFailedBody>(request);
  if (body instanceof Response) return body;

  const failure = buildFailedCommand(body);
  if (failure instanceof Response) return failure;

  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).acceptBuildFailed({
      failure,
      authorizationHeader: request.headers.get("Authorization"),
      callbackToken: getImageBuildCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result, ctx);
  } catch (e) {
    return imageBuildErrorToResponse(e);
  }
}

/** Shared trigger execution behind the per-scope trigger handlers. */
async function triggerBuildForScope(
  env: Env,
  scope: ImageBuildScope,
  ctx: RequestContext
): Promise<Response> {
  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).triggerBuild(
      scope,
      workflowContext(ctx)
    );
    if (result.type === "up_to_date") {
      // Unreachable via the trigger routes (triggerBuild is unconditional);
      // guards the union exhaustively.
      return json({ ok: true, upToDate: true });
    }
    return json({
      buildId: result.buildId,
      status: "building",
      alreadyBuilding: result.type === "already_building",
    });
  } catch (e) {
    return imageBuildErrorToResponse(e);
  }
}

/**
 * POST /image-builds/trigger/environment/:id
 * Trigger a build for an environment scope (cron, save-hooks, manual rebuild).
 */
async function handleTriggerEnvironmentBuild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const environmentId = match.groups?.id;
  if (!environmentId) return error("Environment ID required", 400);

  return triggerBuildForScope(env, { kind: "environment", id: environmentId }, ctx);
}

/**
 * POST /image-builds/trigger/repo/:owner/:name
 * Trigger a build for a repo scope (cron, save-hooks, manual rebuild).
 */
async function handleTriggerRepoBuild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;

  return triggerBuildForScope(env, repoImageBuildScope(params.owner, params.name), ctx);
}

/**
 * PUT /image-builds/toggle/repo/:owner/:name
 * Toggle prebuilds for a repo (the repo_metadata.image_build_enabled write).
 * Toggling on triggers an immediate build via the save-hook, same as saving
 * a prebuild-enabled environment; the environment toggle stays on the
 * environments CRUD (prebuildEnabled).
 */
async function handleToggleRepoImageBuilds(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const body = await parseJsonBody<{ enabled?: unknown }>(request);
  if (body instanceof Response) return body;

  if (typeof body.enabled !== "boolean") {
    return error("enabled must be a boolean", 400);
  }

  const scope = repoImageBuildScope(owner, name);

  // Enabling an unknown or unresolvable repo would persist a flag whose
  // builds can never plan; resolve through the trigger path's canonical
  // resolver first and only persist on success. Disabling never resolves —
  // a repo that became unresolvable must remain disableable.
  if (body.enabled) {
    try {
      await resolveScopeTarget(env, ctx.db, scope);
    } catch (e) {
      return imageBuildErrorToResponse(e);
    }
  }

  try {
    await new RepoMetadataStore(ctx.db).setImageBuildEnabled(owner, name, body.enabled);
  } catch (e) {
    logger.error("image_build.toggle_error", {
      error: e instanceof Error ? e.message : String(e),
      scope_kind: scope.kind,
      scope_id: scope.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to toggle image builds", 500);
  }

  logger.info("image_build.toggle", {
    scope_kind: scope.kind,
    scope_id: scope.id,
    enabled: body.enabled,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  if (body.enabled) {
    scheduleImageBuildOnSave(env, scope, ctx);
  }

  return json({ ok: true, enabled: body.enabled });
}

function parseScopeParams(request: Request): ImageBuildScope | null | Response {
  const params = new URL(request.url).searchParams;
  const scopeKind = params.get("scope_kind");
  const scopeId = params.get("scope_id");
  if (scopeKind === null && scopeId === null) return null;
  if (scopeKind !== "repo" && scopeKind !== "environment") {
    return error("scope_kind must be 'repo' or 'environment'", 400);
  }
  if (!scopeId) {
    return error("scope_id is required with scope_kind", 400);
  }
  return { kind: scopeKind, id: scopeId };
}

async function readStatusRows(
  db: SqlDatabase,
  scope: ImageBuildScope | null
): Promise<ImageBuildRecordView[]> {
  const store = new ImageBuildStore(db);
  if (scope) return store.getStatus(scope);
  return store.getStatusForEnabledScopes(await listEnabledScopes(db));
}

/**
 * GET /image-builds/status[?scope_kind=&scope_id=]
 * With a scope: that scope's recent non-superseded rows (the settings UI /
 * debugging view). Without: the cron's cross-scope view over every
 * prebuild-enabled scope — non-superseded, so failed builds are visible in
 * the aggregate feed. Rows are the `ImageBuildRecordView` projection
 * (snake_case columns; repository_shas is a JSON document) — the store drops
 * internal columns, so no callback token or provider id reaches a client.
 */
async function handleGetStatus(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const scope = parseScopeParams(request);
  if (scope instanceof Response) return scope;

  try {
    return json({ images: await readStatusRows(ctx.db, scope) });
  } catch (e) {
    logger.error("image_build.status_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get image status", 500);
  }
}

/**
 * GET /image-builds/enabled
 * Prebuild-enabled scopes with their current repositories and fingerprint,
 * plus the runtime floor — everything the cron's trigger checks need, so the
 * fingerprint algorithm never leaves the control plane.
 */
async function handleGetEnabledUnits(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  try {
    const units = await listEnabledScopeUnits(env, ctx.db);
    return json({
      units: units.map((unit) => ({
        scopeKind: unit.scope.kind,
        scopeId: unit.scope.id,
        repositoriesFingerprint: unit.repositoriesFingerprint,
        repositories: unit.repositories,
      })),
      minRuntimeVersion: MIN_COMPATIBLE_RUNTIME_VERSION,
    });
  } catch (e) {
    logger.error("image_build.enabled_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get enabled scopes", 500);
  }
}

/**
 * GET /image-builds/enabled-repos
 * The persisted repo prebuild flags (a plain D1 read, no source-control
 * resolution). This is the settings UI's toggle-state feed: unlike the
 * units feed, a repo is never dropped on a transient resolution failure.
 */
async function handleGetEnabledRepos(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  try {
    return json({ repos: await new RepoMetadataStore(ctx.db).getImageBuildEnabledRepos() });
  } catch (e) {
    logger.error("image_build.enabled_repos_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get enabled repos", 500);
  }
}

/**
 * POST /image-builds/mark-stale
 * Mark old building rows as failed. Called by scheduler.
 */
async function handleMarkStale(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const maxAgeMs = await parseMaxAgeMs(request, DEFAULT_STALE_BUILD_MAX_AGE_MS);
  if (maxAgeMs instanceof Response) return maxAgeMs;

  const store = new ImageBuildStore(ctx.db);

  try {
    const count = await store.markStaleBuildsAsFailed(maxAgeMs);

    logger.info("image_build.stale_marked", {
      count,
      max_age_seconds: maxAgeMs / MS_PER_SECOND,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, markedFailed: count });
  } catch (e) {
    logger.error("image_build.mark_stale_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark stale builds", 500);
  }
}

/**
 * POST /image-builds/cleanup
 * Reap provider artifacts from failed and superseded rows, then delete old
 * (artifact-free) failed rows. Called by scheduler.
 */
async function handleCleanup(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireImageBuilds(env);
  if (providerError) return providerError;

  const maxAgeMs = await parseMaxAgeMs(request, DEFAULT_FAILED_BUILD_CLEANUP_MAX_AGE_MS);
  if (maxAgeMs instanceof Response) return maxAgeMs;

  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).cleanupImages(
      maxAgeMs,
      workflowContext(ctx)
    );

    logger.info("image_build.cleanup", {
      deleted: result.deletedFailed,
      reaped_failed: result.reapedFailed,
      reaped_superseded: result.reapedSuperseded,
      max_age_seconds: maxAgeMs / MS_PER_SECOND,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      ok: true,
      deleted: result.deletedFailed,
      reapedFailed: result.reapedFailed,
      reapedSuperseded: result.reapedSuperseded,
    });
  } catch (e) {
    logger.error("image_build.cleanup_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to clean up old builds", 500);
  }
}

export const imageBuildRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/image-builds/build-complete"),
    handler: handleBuildComplete,
  },
  {
    method: "POST",
    pattern: parsePattern("/image-builds/build-failed"),
    handler: handleBuildFailed,
  },
  {
    method: "POST",
    pattern: parsePattern("/image-builds/trigger/environment/:id"),
    handler: handleTriggerEnvironmentBuild,
  },
  {
    method: "POST",
    pattern: parsePattern("/image-builds/trigger/repo/:owner/:name"),
    handler: handleTriggerRepoBuild,
  },
  {
    method: "PUT",
    pattern: parsePattern("/image-builds/toggle/repo/:owner/:name"),
    handler: handleToggleRepoImageBuilds,
  },
  {
    method: "GET",
    pattern: parsePattern("/image-builds/status"),
    handler: handleGetStatus,
  },
  {
    method: "GET",
    pattern: parsePattern("/image-builds/enabled"),
    handler: handleGetEnabledUnits,
  },
  {
    method: "GET",
    pattern: parsePattern("/image-builds/enabled-repos"),
    handler: handleGetEnabledRepos,
  },
  {
    method: "POST",
    pattern: parsePattern("/image-builds/mark-stale"),
    handler: handleMarkStale,
  },
  {
    method: "POST",
    pattern: parsePattern("/image-builds/cleanup"),
    handler: handleCleanup,
  },
];
