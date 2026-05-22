/**
 * Model-preferences routes and handlers.
 */

import {
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL as SHARED_DEFAULT_MODEL,
  DEFAULT_PLAN_MODEL as SHARED_DEFAULT_PLAN_MODEL,
  getValidModelOrDefault,
} from "@open-inspect/shared";
import {
  ModelPreferencesStore,
  ModelPreferencesValidationError,
  type ModelPreferences,
} from "../db/model-preferences";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
} from "./shared";

const logger = createLogger("router:model-preferences");

/**
 * Resolve effective default models with fallback chain: DB > env > shared.
 * getValidModelOrDefault() normalizes bare ids and rejects invalid ones; the
 * shared constants explicitly take over when the env var is missing so that
 * the impl-default and plan-default fallbacks stay distinct.
 */
function resolveDefaults(
  env: Env,
  prefs: ModelPreferences | null
): { defaultModel: string; defaultPlanModel: string } {
  const defaultModel =
    prefs?.defaultModel ??
    (env.DEFAULT_MODEL ? getValidModelOrDefault(env.DEFAULT_MODEL) : SHARED_DEFAULT_MODEL);
  const defaultPlanModel =
    prefs?.defaultPlanModel ??
    (env.DEFAULT_PLAN_MODEL
      ? getValidModelOrDefault(env.DEFAULT_PLAN_MODEL)
      : SHARED_DEFAULT_PLAN_MODEL);
  return { defaultModel, defaultPlanModel };
}

/**
 * Reconcile resolved defaults against the enabled-models set.
 *
 * setPreferences() enforces `defaultModel ∈ enabledModels` (same for
 * defaultPlanModel), but the GET path's fallback chain can produce
 * env/shared defaults that aren't members of the configured enabledModels.
 * Returning that mismatched state breaks the invariant — a subsequent PUT
 * with the unchanged tuple would fail validation, leaving the Settings
 * page unable to save.
 *
 * If a resolved default isn't in the enabled set we substitute the first
 * enabled model (the same fallback the web Settings UI applies when the
 * stored default is disabled).
 */
function reconcileDefaultsWithEnabled(
  enabledModels: readonly string[],
  defaults: { defaultModel: string; defaultPlanModel: string }
): { defaultModel: string; defaultPlanModel: string } {
  if (enabledModels.length === 0) return defaults;
  const enabledSet = new Set(enabledModels);
  const fallback = enabledModels[0];
  return {
    defaultModel: enabledSet.has(defaults.defaultModel) ? defaults.defaultModel : fallback,
    defaultPlanModel: enabledSet.has(defaults.defaultPlanModel)
      ? defaults.defaultPlanModel
      : fallback,
  };
}

async function handleGetModelPreferences(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    const defaults = reconcileDefaultsWithEnabled(
      DEFAULT_ENABLED_MODELS,
      resolveDefaults(env, null)
    );
    return json({ enabledModels: DEFAULT_ENABLED_MODELS, ...defaults });
  }

  const store = new ModelPreferencesStore(env.DB);

  try {
    const prefs = await store.getPreferences();
    const enabledModels = prefs?.enabledModels ?? DEFAULT_ENABLED_MODELS;
    const defaults = reconcileDefaultsWithEnabled(enabledModels, resolveDefaults(env, prefs));
    return json({ enabledModels, ...defaults });
  } catch (e) {
    logger.error("Failed to get model preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    const defaults = reconcileDefaultsWithEnabled(
      DEFAULT_ENABLED_MODELS,
      resolveDefaults(env, null)
    );
    return json({ enabledModels: DEFAULT_ENABLED_MODELS, ...defaults });
  }
}

async function handleSetModelPreferences(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Model preferences storage is not configured", 503);
  }

  const body = await parseJsonBody<{
    enabledModels?: string[];
    defaultModel?: string | null;
    defaultPlanModel?: string | null;
  }>(request);
  if (body instanceof Response) return body;

  if (!body?.enabledModels || !Array.isArray(body.enabledModels)) {
    return error("Request body must include enabledModels array", 400);
  }

  const store = new ModelPreferencesStore(env.DB);
  const prefs: ModelPreferences = {
    enabledModels: [...new Set(body.enabledModels)],
    // Treat explicit null and missing field both as "delegate to fallback".
    defaultModel: body.defaultModel ?? null,
    defaultPlanModel: body.defaultPlanModel ?? null,
  };

  try {
    await store.setPreferences(prefs);

    logger.info("model_preferences.updated", {
      event: "model_preferences.updated",
      enabled_count: prefs.enabledModels.length,
      has_default_model: prefs.defaultModel !== null,
      has_default_plan_model: prefs.defaultPlanModel !== null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      status: "updated",
      enabledModels: prefs.enabledModels,
      defaultModel: prefs.defaultModel,
      defaultPlanModel: prefs.defaultPlanModel,
    });
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

export const modelPreferencesRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/model-preferences"),
    handler: handleGetModelPreferences,
  },
  {
    method: "PUT",
    pattern: parsePattern("/model-preferences"),
    handler: handleSetModelPreferences,
  },
];
