import { MODEL_OPTIONS, normalizeValidModels, type ValidModel } from "@open-inspect/shared/models";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import type { ModelOption } from "./slack-types";

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

export async function getAuthoritativeModels(
  env: Env,
  traceId?: string
): Promise<ValidModel[] | null> {
  try {
    const response = await signedControlPlaneFetch(env, {
      method: "GET",
      url: "https://internal/model-preferences?strict=true",
      traceId,
    });
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

/** Null means enablement is unknown, not that a configured model is disabled. */
export async function getAvailableModels(
  env: Env,
  traceId?: string
): Promise<ModelOption[] | null> {
  const enabledModels = await getAuthoritativeModels(env, traceId);
  if (!enabledModels) return null;
  const enabledSet = new Set<ValidModel>(enabledModels);
  return ALL_MODELS.filter((model) => enabledSet.has(model.value));
}
