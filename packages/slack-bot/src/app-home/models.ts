import {
  DEFAULT_ENABLED_MODELS,
  MODEL_OPTIONS,
  isValidModel,
  normalizeValidModels,
  type SlackGlobalConfig,
} from "@open-inspect/shared";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { ModelOption } from "./slack-types";

const ALL_MODELS = MODEL_OPTIONS.flatMap((group) =>
  group.models.map((model) => ({
    label: `${model.name} (${model.description})`,
    value: model.id,
  }))
);

function getDefaultModelOptions(): ModelOption[] {
  const defaultSet = new Set<string>(DEFAULT_ENABLED_MODELS);
  const defaultOptions = ALL_MODELS.filter((model) => defaultSet.has(model.value));
  return defaultOptions.length > 0 ? defaultOptions : ALL_MODELS;
}

export async function getAvailableModels(env: Env, traceId?: string): Promise<ModelOption[]> {
  try {
    const url = "https://internal/model-preferences";
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });

    if (response.ok) {
      const data = (await response.json()) as { enabledModels?: unknown };
      if (
        Array.isArray(data.enabledModels) &&
        data.enabledModels.every((id): id is string => typeof id === "string")
      ) {
        const enabledSet = new Set(normalizeValidModels(data.enabledModels));
        const enabledModels = ALL_MODELS.filter((model) => enabledSet.has(model.value));
        if (enabledModels.length > 0) {
          return enabledModels;
        }
      }
    }
  } catch {
    // Fall through to defaults
  }

  return getDefaultModelOptions();
}

export async function getSlackDefaultModel(
  env: Env,
  traceId?: string
): Promise<string | undefined> {
  try {
    const url = "https://internal/integration-settings/slack";
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { settings: SlackGlobalConfig | null };
    const model = data.settings?.defaults?.model;
    return model && isValidModel(model) ? model : undefined;
  } catch {
    return undefined;
  }
}
