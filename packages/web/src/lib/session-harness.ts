import {
  filterModelsForHarness,
  getHarnessLabel,
  harnessSupportsModel,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import type { ModelCategory, ReasoningEffort, ValidModel } from "@open-inspect/shared/models";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";

/** Model picker groups reduced to the models the harness can run. */
export function filterModelOptionsForHarness(
  harness: HarnessId,
  options: ModelCategory[]
): ModelCategory[] {
  return options
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => harnessSupportsModel(harness, model.id)),
    }))
    .filter((group) => group.models.length > 0);
}

export type HarnessModelAvailability =
  | { status: "loading" }
  | { status: "available" }
  | { status: "unavailable"; message: string };

export interface HarnessModelSelection {
  /** Whether `model` may be submitted; anything else holds submission. */
  availability: HarnessModelAvailability;
  /** Picker groups holding only the enabled models the harness can run. */
  options: ModelCategory[];
  model: ValidModel;
  reasoningEffort?: ReasoningEffort;
}

/**
 * The one harness-aware model selection every composer derives its picker,
 * its submitted model and its submit gate from. A preference the harness
 * cannot run resolves to an enabled model it can. While the enabled set loads,
 * or when the harness can run none of the enabled models, the preference
 * stands for display only and `availability` says why nothing may be sent.
 */
export function resolveHarnessModelSelection({
  harness,
  preference,
  enabledModels,
  enabledModelOptions,
  loading,
}: {
  harness: HarnessId;
  preference: ModelPreference;
  enabledModels: readonly string[];
  enabledModelOptions: ModelCategory[];
  loading: boolean;
}): HarnessModelSelection {
  const options = filterModelOptionsForHarness(harness, enabledModelOptions);
  if (loading) {
    return { availability: { status: "loading" }, options, ...resolveModelPreference(preference) };
  }
  const models = filterModelsForHarness(harness, enabledModels);
  if (models.length === 0) {
    return {
      availability: {
        status: "unavailable",
        message: `No enabled models can run on ${getHarnessLabel(harness)}.`,
      },
      options,
      ...resolveModelPreference(preference),
    };
  }
  return {
    availability: { status: "available" },
    options,
    ...resolveModelPreference(preference, models),
  };
}
