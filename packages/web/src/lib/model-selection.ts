import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  resolveEnabledModel,
} from "@open-inspect/shared/models";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined
): ModelPreference {
  const model = enabledModels
    ? resolveEnabledModel({
        model: preference.model,
        enabledModels,
        fallbackModel: DEFAULT_MODEL,
      })
    : getValidModelOrDefault(preference.model);
  return {
    model,
    reasoningEffort:
      preference.reasoningEffort && isValidReasoningEffort(model, preference.reasoningEffort)
        ? preference.reasoningEffort
        : getDefaultReasoningEffort(model),
  };
}
