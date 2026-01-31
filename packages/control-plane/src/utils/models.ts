/**
 * Model validation and extraction utilities.
 *
 * Centralizes model-related logic to ensure consistent validation
 * across session initialization and message processing.
 */

/**
 * Valid model names supported by the system.
 */
export const VALID_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"] as const;

export type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Default model to use when none specified or invalid.
 */
export const DEFAULT_MODEL: ValidModel = "claude-haiku-4-5";

/**
 * Check if a model name is valid.
 */
export function isValidModel(model: string): model is ValidModel {
  return VALID_MODELS.includes(model as ValidModel);
}

/**
 * Extract provider and model from a model ID.
 *
 * Models with "/" have embedded provider (kept for backward compatibility with existing sessions).
 * Models like "claude-haiku-4-5" use "anthropic" as default provider.
 *
 * @example
 * extractProviderAndModel("claude-haiku-4-5") // { provider: "anthropic", model: "claude-haiku-4-5" }
 * extractProviderAndModel("anthropic/claude-3-opus") // { provider: "anthropic", model: "claude-3-opus" }
 */
export function extractProviderAndModel(modelId: string): { provider: string; model: string } {
  if (modelId.includes("/")) {
    const [provider, ...modelParts] = modelId.split("/");
    return { provider, model: modelParts.join("/") };
  }
  return { provider: "anthropic", model: modelId };
}

/**
 * Get a valid model or fall back to default.
 */
export function getValidModelOrDefault(model: string | undefined | null): ValidModel {
  if (model && isValidModel(model)) {
    return model;
  }
  return DEFAULT_MODEL;
}
