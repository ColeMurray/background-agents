/**
 * Fetch the deployment-wide default models from the control plane.
 *
 * Used by the linear-bot, github-bot, and slack-bot to source the default
 * model + default plan model from a single place (the control plane's
 * `model_preferences` D1 row, configurable via Settings → Models in the web
 * UI) instead of each bot reading its own `env.DEFAULT_MODEL`.
 *
 * The bot resolution chain becomes:
 *   1. fetch /model-preferences → DB row > env var > shared constant
 *   2. on fetch failure, fall back to the bot's own env / shared constant
 */

import { buildInternalAuthHeaders } from "./auth";
import type { ControlPlaneFetcher } from "./completion/extractor";
import { DEFAULT_MODEL, DEFAULT_PLAN_MODEL } from "./models";

export interface ModelDefaults {
  defaultModel: string;
  defaultPlanModel: string;
}

export interface FetchModelDefaultsEnv {
  CONTROL_PLANE: ControlPlaneFetcher;
  INTERNAL_CALLBACK_SECRET?: string;
  DEFAULT_MODEL?: string;
  DEFAULT_PLAN_MODEL?: string;
}

interface ModelPreferencesResponse {
  enabledModels?: string[];
  defaultModel?: string;
  defaultPlanModel?: string;
}

/**
 * Resolve the deployment's default + plan default models, with full fallback.
 *
 * Fallback order: control-plane response > env var > shared library constant.
 * Network or non-2xx responses log nothing (caller decides) and fall through
 * to the env-var path, so bots stay functional during a CP outage.
 */
export async function fetchModelDefaults(env: FetchModelDefaultsEnv): Promise<ModelDefaults> {
  try {
    const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);
    const res = await env.CONTROL_PLANE.fetch("https://internal/model-preferences", {
      method: "GET",
      headers,
    });
    if (res.ok) {
      const data = (await res.json()) as ModelPreferencesResponse;
      if (data.defaultModel && data.defaultPlanModel) {
        return {
          defaultModel: data.defaultModel,
          defaultPlanModel: data.defaultPlanModel,
        };
      }
    }
  } catch {
    // Service-binding / network failure — fall through to env-or-shared
  }
  return {
    defaultModel: env.DEFAULT_MODEL || DEFAULT_MODEL,
    defaultPlanModel: env.DEFAULT_PLAN_MODEL || DEFAULT_PLAN_MODEL,
  };
}
