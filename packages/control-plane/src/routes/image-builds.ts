/**
 * Image build routes.
 *
 * Handles:
 * - Build callbacks from async image builders (build-complete, build-failed)
 * - Manual build triggers and the repo-toggle save hook
 * - The repo prebuild toggle (the repo_metadata flag write)
 * - Enabled-scope and status queries
 */

import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { z } from "zod";
import { ImageBuildStore } from "../db/image-builds";
import { RepoMetadataStore } from "../db/repo-metadata";
import { createLogger } from "../logger";
import { getImageBuildCallbackBearerToken } from "../image-builds/callback-auth";
import { ImageBuildError } from "../image-builds/errors";
import {
  parseRuntimeVersionNumber,
  repoImageBuildScope,
  type ImageBuildScope,
} from "../image-builds/model";
import { getImageBuildsUnsupportedMessage } from "../image-builds/provider-policy";
import { repositoryShaEntrySchema } from "../image-builds/provenance";
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
  parsePattern,
} from "./shared";

const logger = createLogger("router:image-builds");
const MAX_CALLBACK_BODY_BYTES = 16 * 1024;

/**
 * Build-complete callback body. Every field is required: all providers bind a
 * provider session before the runtime launches, and the runtime always
 * reports repository_shas and runtime_version — an unversioned image must
 * never be registered, or it could pass spawn selection's floor check.
 */
const buildCompleteBodySchema = z.object({
  build_id: z.string().min(1),
  provider_session_id: z.string().min(1),
  repository_shas: z.array(repositoryShaEntrySchema).min(1),
  runtime_version: z.string().refine((value) => parseRuntimeVersionNumber(value) !== null, {
    message: "must start with v<number>",
  }),
  // Must stay finite: Infinity would be canonicalized to null by
  // JSON.stringify inside the completion hash and the persisted row. Capped
  // at MAX_SAFE_INTEGER so an absurd duration cannot lose integer precision
  // in the persisted row or the completion-hash canonicalization.
  build_duration_seconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const buildFailedBodySchema = z.object({
  build_id: z.string().min(1),
  provider_session_id: z.string().min(1),
  // Deliberately tolerant: a malformed error report must never 400 the one
  // callback that moves a wedged build out of `building` — anything that is
  // not a non-empty string falls back to "Unknown error" at the handler.
  error: z.unknown().optional(),
});

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

function workflowResultToResponse(result: ImageBuildWorkflowResult): Response {
  switch (result.type) {
    case "completion_accepted":
      return json({ ok: true, snapshotPending: true }, 202);
    case "failure_accepted":
      return json({ ok: true, cleanupPending: true }, 202);
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
      return error(errorValue.message, 500);
    default: {
      const exhaustive: never = errorValue.code;
      return error(`Unhandled image build error: ${String(exhaustive)}`, 500);
    }
  }
}

/**
 * Read and JSON-parse a size-bounded callback body. Schema validation is the
 * caller's — this only guards transport-level failure modes (oversized or
 * non-JSON payloads).
 */
async function readCallbackBody(request: Request): Promise<{ body: unknown } | Response> {
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
    return { body: JSON.parse(bodyText) };
  } catch {
    return error("Invalid JSON body", 400);
  }
}

/**
 * Parse a callback body against its schema. Missing or invalid fields are a
 * 400 before auth — field presence leaks nothing about any build row.
 */
function parseCallbackBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown
): z.infer<Schema> | Response {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const path = issue.path.join(".");
  return error(path ? `${path}: ${issue.message}` : issue.message, 400);
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
  const body = await readCallbackBody(request);
  if (body instanceof Response) return body;

  const parsed = parseCallbackBody(buildCompleteBodySchema, body.body);
  if (parsed instanceof Response) return parsed;

  const completion: CompleteImageBuildCallback = {
    buildId: parsed.build_id,
    providerSessionId: parsed.provider_session_id,
    repositoryShas: parsed.repository_shas,
    runtimeVersion: parsed.runtime_version,
    buildDurationSeconds: parsed.build_duration_seconds,
  };

  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).acceptBuildComplete({
      completion,
      callbackToken: getImageBuildCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result);
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
  const body = await readCallbackBody(request);
  if (body instanceof Response) return body;

  const parsed = parseCallbackBody(buildFailedBodySchema, body.body);
  if (parsed instanceof Response) return parsed;

  const failure: FailImageBuildCallback = {
    buildId: parsed.build_id,
    providerSessionId: parsed.provider_session_id,
    errorMessage:
      typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : "Unknown error",
  };

  try {
    const result = await createImageBuildWorkflowFromEnv(env, ctx.db).acceptBuildFailed({
      failure,
      callbackToken: getImageBuildCallbackBearerToken(request),
      context: workflowContext(ctx),
    });
    return workflowResultToResponse(result);
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
 * Trigger a manual rebuild for an environment scope.
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
 * Trigger a manual rebuild for a repo scope.
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
 * Prebuild-enabled scope identities with their current repository-set
 * fingerprints for the settings and session-target feeds.
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
      })),
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
];
