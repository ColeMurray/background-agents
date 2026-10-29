import {
  DEFAULT_HARNESS,
  getHarnessReasoningConfig,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  DEFAULT_MODEL,
  getValidModelOrDefault,
  resolveEnabledModel,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";

export interface ModelPreference {
  model: string;
  reasoningEffort?: string;
}

export interface ResolvedModelPreference {
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
}

export function resolveModelPreference(
  preference: ModelPreference,
  enabledModels?: readonly string[],
  harness: HarnessId = DEFAULT_HARNESS
): ResolvedModelPreference {
  const model = enabledModels
    ? resolveEnabledModel({
        model: preference.model,
        enabledModels,
        fallbackModel: DEFAULT_MODEL,
      })
    : getValidModelOrDefault(preference.model);
  // Efforts differ by harness (Codex offers `max` where the generic catalog does not).
  const reasoningConfig = getHarnessReasoningConfig(harness, model);
  return {
    model,
    reasoningEffort:
      preference.reasoningEffort === undefined
        ? undefined
        : (reasoningConfig?.efforts.find((effort) => effort === preference.reasoningEffort) ??
          reasoningConfig?.default),
  };
}
