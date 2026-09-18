import {
  DEFAULT_ENABLED_MODELS,
  MODEL_OPTIONS,
  normalizeValidModels,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { ModelOption } from "./slack-types";
import { getSlackSettings } from "../slack-settings";

const ALL_MODELS = MODEL_OPTIONS.flatMap((group) =>
  group.models.map((model) => ({
    label: `${model.name} (${model.description})`,
    value: model.id,
  }))
);

export const MODEL_PREFERENCES_UNAVAILABLE_MESSAGE =
  "Model preferences are temporarily unavailable. Please try again.";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDefaultModelOptions(): ModelOption[] {
  const defaultSet = new Set<string>(DEFAULT_ENABLED_MODELS);
  const defaultOptions = ALL_MODELS.filter((model) => defaultSet.has(model.value));
  return defaultOptions.length > 0 ? defaultOptions : ALL_MODELS;
}

async function fetchEnabledModels(
  env: Env,
  url: string,
  traceId?: string
): Promise<ValidModel[] | null> {
  try {
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });
    if (!response.ok) return null;
    const data = await response.json();
    if (
      !isObject(data) ||
      !Array.isArray(data.enabledModels) ||
      !data.enabledModels.every((id): id is string => typeof id === "string")
    ) {
      return null;
    }
    const enabledModels = normalizeValidModels(data.enabledModels);
    return enabledModels.length > 0 ? enabledModels : null;
  } catch {
    return null;
  }
}

export async function getAvailableModels(env: Env, traceId?: string): Promise<ModelOption[]> {
  const enabledModels = await fetchEnabledModels(
    env,
    "https://internal/model-preferences",
    traceId
  );
  if (!enabledModels) return getDefaultModelOptions();
  const enabledSet = new Set<ValidModel>(enabledModels);
  return ALL_MODELS.filter((model) => enabledSet.has(model.value));
}

export async function getAuthoritativeModels(
  env: Env,
  traceId?: string
): Promise<ValidModel[] | null> {
  return fetchEnabledModels(env, "https://internal/model-preferences?strict=true", traceId);
}

export async function getSlackDefaultModel(
  env: Env,
  traceId?: string
): Promise<string | undefined> {
  return (await getSlackSettings(env, traceId)).defaultModel;
}
