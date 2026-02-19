/**
 * Model-preferences routes and handlers.
 */

import { DEFAULT_ENABLED_MODELS } from "@open-inspect/shared";
import { ModelPreferencesStore, ModelPreferencesValidationError } from "../db/model-preferences";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:model-preferences");

async function handleGetModelPreferences(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return json({ enabledModels: DEFAULT_ENABLED_MODELS });
  }

  const store = new ModelPreferencesStore(env.DB);

  try {
    const enabledModels = await store.getEnabledModels();

    return json({ enabledModels: enabledModels ?? DEFAULT_ENABLED_MODELS });
  } catch (e) {
    logger.error("Failed to get model preferences", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ enabledModels: DEFAULT_ENABLED_MODELS });
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

  let body: { enabledModels?: string[] };
  try {
    body = (await request.json()) as { enabledModels?: string[] };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.enabledModels || !Array.isArray(body.enabledModels)) {
    return error("Request body must include enabledModels array", 400);
  }

  const store = new ModelPreferencesStore(env.DB);

  try {
    const deduplicated = [...new Set(body.enabledModels)];
    await store.setEnabledModels(deduplicated);

    logger.info("model_preferences.updated", {
      event: "model_preferences.updated",
      enabled_count: deduplicated.length,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", enabledModels: deduplicated });
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
