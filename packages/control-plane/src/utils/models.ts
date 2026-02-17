/**
 * Model validation and extraction utilities.
 *
 * Re-exports from @open-inspect/shared for backward compatibility.
 */

export {
  VALID_MODELS,
  type ValidModel,
  DEFAULT_MODEL,
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
