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
import { DEFAULT_MODEL, DEFAULT_PLAN_MODEL, isValidModel, normalizeModelId } from "./models";

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
  // Per-field fallback chain — each field independently resolves
  // `DB row > env var > shared constant`. The previous all-or-nothing
  // gate discarded a present `defaultModel` from the DB whenever
  // `defaultPlanModel` was null (or vice versa), forcing both fields
  // to fall back to env/constants together.
  let dbDefaultModel: string | undefined;
  let dbDefaultPlanModel: string | undefined;
  try {
    const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);
    const res = await env.CONTROL_PLANE.fetch("https://internal/model-preferences", {
      method: "GET",
      headers,
    });
    if (res.ok) {
      const data = (await res.json()) as ModelPreferencesResponse;
      dbDefaultModel = data.defaultModel ?? undefined;
      dbDefaultPlanModel = data.defaultPlanModel ?? undefined;
    }
  } catch {
    // Service-binding / network failure — fall through to env-or-shared
  }
  return {
    defaultModel:
      normalizeFallback(dbDefaultModel) || normalizeFallback(env.DEFAULT_MODEL) || DEFAULT_MODEL,
    defaultPlanModel:
      normalizeFallback(dbDefaultPlanModel) ||
      normalizeFallback(env.DEFAULT_PLAN_MODEL) ||
      DEFAULT_PLAN_MODEL,
  };
}

/**
 * Resolve a candidate value (from DB or env) to a fully-qualified, valid
 * model ID. Returns undefined for missing / invalid values so the caller
 * can fall through to the next link in the fallback chain.
 *
 * The control plane's `/model-preferences` already returns normalized IDs,
 * but operator-configured env vars sometimes carry bare names (e.g.
 * `claude-sonnet-4-6` instead of `anthropic/claude-sonnet-4-6`). Without
 * this normalization, an env-var fallback during a CP outage could surface
 * a bare ID to callers that expect the qualified form.
 */
function normalizeFallback(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  return isValidModel(candidate) ? normalizeModelId(candidate) : undefined;
}
