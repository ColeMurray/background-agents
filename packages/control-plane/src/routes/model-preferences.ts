/**
 * Model-preferences routes and handlers.
 */

import { Hono } from "hono";
import { DEFAULT_ENABLED_MODELS, normalizeValidModels } from "@open-inspect/shared/models";
import { ModelPreferencesStore, ModelPreferencesValidationError } from "../db/model-preferences";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  parseJsonBody,
  activeGlobal,
  requirePermission,
} from "./shared";

const logger = createLogger("router:model-preferences");

async function getModelPreferences(ctx: RequestContext): Promise<Response> {
  if (!ctx.db) {
    return json({ enabledModels: DEFAULT_ENABLED_MODELS });
  }

  const store = new ModelPreferencesStore(ctx.db);

  try {
    const enabledModels = await store.getEnabledModels();
    if (!enabledModels) return json({ enabledModels: DEFAULT_ENABLED_MODELS });

    const normalized = normalizeValidModels(enabledModels);
    const reconciled = normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
    if (JSON.stringify(reconciled) !== JSON.stringify(enabledModels)) {
      logger.info("model_preferences.reconciled", {
        event: "model_preferences.reconciled",
        stored_count: enabledModels.length,
        valid_count: normalized.length,
        fallback_applied: normalized.length === 0,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }

    return json({ enabledModels: reconciled });
  } catch (e) {
    logger.error("Failed to get model preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ enabledModels: DEFAULT_ENABLED_MODELS });
  }
}

async function setModelPreferences(request: Request, ctx: RequestContext): Promise<Response> {
  if (!ctx.db) {
    return error("Model preferences storage is not configured", 503);
  }

  const body = await parseJsonBody<{ enabledModels?: unknown[] }>(request);
  if (body instanceof Response) return body;

  if (!body?.enabledModels || !Array.isArray(body.enabledModels)) {
    return error("Request body must include enabledModels array", 400);
  }
  if (!body.enabledModels.every((id): id is string => typeof id === "string")) {
    return error("enabledModels must contain only strings", 400);
  }

  const store = new ModelPreferencesStore(ctx.db);

  try {
    const enabledModels = await store.setEnabledModels(body.enabledModels);

    logger.info("model_preferences.updated", {
      event: "model_preferences.updated",
      enabled_count: enabledModels.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", enabledModels });
  } catch (e) {
    if (e instanceof ModelPreferencesValidationError) {
      return error(e.message, 400);
    }
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
  (c) => getModelPreferences(c.var.admitted.ctx)
);

modelPreferencesRoutes.put(
  "/model-preferences",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("models.preferences.manage"),
  }),
  (c) => setModelPreferences(c.var.admitted.request, c.var.admitted.ctx)
);
