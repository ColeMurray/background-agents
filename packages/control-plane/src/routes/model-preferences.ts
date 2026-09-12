/**
 * Model-preferences routes and handlers.
 */

import { Hono } from "hono";
import type { Env } from "../types";
import {
  DEFAULT_ENABLED_MODELS,
  isValidModel,
  normalizeModelId,
  type ModelPreferenceChange,
} from "@open-inspect/shared/models";
import {
  ModelPreferencesConflictError,
  ModelPreferencesStore,
  ModelPreferencesValidationError,
} from "../db/model-preferences";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  activeGlobal,
  requirePermission,
} from "./shared";
import { parseJsonBody } from "./body";

const logger = createLogger("router:model-preferences");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getModelPreferences(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) {
    return json({ enabledModels: DEFAULT_ENABLED_MODELS, revision: 0 });
  }

  const store = new ModelPreferencesStore(ctx.db);

  try {
    const snapshot = await store.getSnapshot();
    if (snapshot.reconciled) {
      logger.info("model_preferences.reconciled", {
        event: "model_preferences.reconciled",
        stored_count: snapshot.storedCount,
        valid_count: snapshot.enabledModels.length,
        fallback_applied: snapshot.fallbackApplied,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }

    return json({ enabledModels: snapshot.enabledModels, revision: snapshot.revision });
  } catch (e) {
    logger.error("Failed to get model preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ enabledModels: DEFAULT_ENABLED_MODELS, revision: 0 });
  }
}

async function setModelPreferences(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  logger.warn("model_preferences.legacy_put_rejected", {
    event: "model_preferences.legacy_put_rejected",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("PUT model preferences updates are no longer supported; use PATCH", 405);
}

function parseModelPreferenceChanges(body: unknown): ModelPreferenceChange[] | Response {
  if (!isRecord(body) || !Array.isArray(body.changes) || body.changes.length === 0) {
    return error("Request body must include a non-empty changes array", 400);
  }

  const changes: ModelPreferenceChange[] = [];
  const seen = new Set<string>();
  for (const value of body.changes) {
    if (
      !isRecord(value) ||
      typeof value.modelId !== "string" ||
      typeof value.enabled !== "boolean"
    ) {
      return error("Each change must include a modelId string and enabled boolean", 400);
    }
    if (!isValidModel(value.modelId) || normalizeModelId(value.modelId) !== value.modelId) {
      return error(`Invalid canonical model ID: ${value.modelId}`, 400);
    }
    if (seen.has(value.modelId)) {
      return error(`Duplicate model preference: ${value.modelId}`, 400);
    }
    seen.add(value.modelId);
    changes.push({ modelId: value.modelId, enabled: value.enabled });
  }
  return changes;
}

async function patchModelPreferences(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Model preferences storage is not configured", 503);

  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;
  const changes = parseModelPreferenceChanges(body);
  if (changes instanceof Response) return changes;

  try {
    const snapshot = await new ModelPreferencesStore(ctx.db).applyChanges(changes);
    logger.info("model_preferences.updated", {
      event: "model_preferences.updated",
      enabled_count: snapshot.enabledModels.length,
      changed_count: changes.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ enabledModels: snapshot.enabledModels, revision: snapshot.revision });
  } catch (e) {
    if (e instanceof ModelPreferencesValidationError) return error(e.message, 400);
    if (e instanceof ModelPreferencesConflictError) return error(e.message, 409);
    logger.error("Failed to update model preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Model preferences storage unavailable", 503);
  }
}

export const modelPreferencesRoutes = new Hono<ControlPlaneHonoEnv>();

modelPreferencesRoutes.get(
  "/model-preferences",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: activeGlobal({ actorlessGrants: [{ service: "slack-bot" }] }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, getModelPreferences)
);

modelPreferencesRoutes.put(
  "/model-preferences",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("models.preferences.manage"),
  }),
  (c) => dispatch(c, setModelPreferences)
);

modelPreferencesRoutes.patch(
  "/model-preferences",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("models.preferences.manage"),
  }),
  (c) => dispatch(c, patchModelPreferences)
);
