import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
  resolveEnabledModel as resolveSharedEnabledModel,
} from "@open-inspect/shared";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

/**
 * Pick the model the automation form should actually use, given a desired model
 * (a blank-create default, a saved automation's model, or a template
 * suggestion) and the user's currently enabled models.
 *
 * The form's model selector only lists enabled models, so a model the user has
 * not enabled would render an unselected control and be submitted verbatim. This
 * coerces to a model that is actually enabled, preferring the desired model,
 * then the system default, then the first enabled model. `getValidModelOrDefault`
 * also normalizes legacy/bare ids and falls back for unknown ones.
 */
export function resolveEnabledModel(model: string, enabledModels: string[]): string {
  return resolveSharedEnabledModel({ model, enabledModels, fallbackModel: DEFAULT_MODEL });
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels: string[] | undefined
): ModelPreference {
  const model = enabledModels
    ? resolveEnabledModel(preference.model, enabledModels)
    : getValidModelOrDefault(preference.model);
  return {
    model,
    reasoningEffort:
      preference.reasoningEffort && isValidReasoningEffort(model, preference.reasoningEffort)
        ? preference.reasoningEffort
        : getDefaultReasoningEffort(model),
  };
}
