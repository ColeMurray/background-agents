/**
 * Model validation and extraction utilities.
 *
 * Re-exports from @open-inspect/shared for backward compatibility.
 */

export {
  VALID_MODELS,
  type ValidModel,
  DEFAULT_MODEL,
  DEFAULT_ENABLED_MODELS,
  MODEL_OPTIONS,
  type ModelCategory,
  type ModelDisplayInfo,
  type ReasoningEffort,
  type ModelReasoningConfig,
  MODEL_REASONING_CONFIG,
  normalizeModelId,
  isValidModel,
  extractProviderAndModel,
  getValidModelOrDefault,
  supportsReasoning,
  getReasoningConfig,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
} from "@open-inspect/shared";
