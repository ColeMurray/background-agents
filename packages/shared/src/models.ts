/**
 * Centralized model definitions and reasoning configuration.
 *
 * All packages import model-related types and validation from here
 * to ensure consistent behavior across control plane, web UI, and Slack bot.
 */

/**
 * Valid model names supported by the system.
 */
export const VALID_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "openai/gpt-5.2",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
] as const;

export type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Default model to use when none specified or invalid.
 */
export const DEFAULT_MODEL: ValidModel = "claude-haiku-4-5";

/**
 * Reasoning effort levels supported across providers.
 *
 * - "none": No reasoning (OpenAI only)
 * - "low"/"medium"/"high"/"xhigh": Progressive reasoning depth
 * - "max": Maximum reasoning budget (Anthropic extended thinking)
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelReasoningConfig {
  efforts: ReasoningEffort[];
  default: ReasoningEffort | undefined;
}

/**
 * Per-model reasoning configuration.
 * Models not listed here do not support reasoning controls.
 */
export const MODEL_REASONING_CONFIG: Partial<Record<ValidModel, ModelReasoningConfig>> = {
  "claude-haiku-4-5": { efforts: ["high", "max"], default: "max" },
  "claude-sonnet-4-5": { efforts: ["high", "max"], default: "max" },
  "claude-opus-4-5": { efforts: ["high", "max"], default: "max" },
  "openai/gpt-5.2": { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
  "openai/gpt-5.2-codex": { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
  "openai/gpt-5.3-codex": { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
};

export interface ModelDisplayInfo {
  id: ValidModel;
  name: string;
  description: string;
}

export interface ModelCategory {
  category: string;
  models: ModelDisplayInfo[];
}

/**
 * Model options grouped by provider, for use in UI dropdowns.
 */
export const MODEL_OPTIONS: ModelCategory[] = [
  {
    category: "Anthropic",
    models: [
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", description: "Fast and efficient" },
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Balanced performance",
      },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", description: "Most capable" },
    ],
  },
  {
    category: "OpenAI",
    models: [
      { id: "openai/gpt-5.2", name: "GPT 5.2", description: "400K context, fast" },
      { id: "openai/gpt-5.2-codex", name: "GPT 5.2 Codex", description: "Optimized for code" },
      { id: "openai/gpt-5.3-codex", name: "GPT 5.3 Codex", description: "Latest codex" },
    ],
  },
];

// === Validation helpers ===

/**
 * Check if a model name is valid.
 */
export function isValidModel(model: string): model is ValidModel {
  return VALID_MODELS.includes(model as ValidModel);
}

/**
 * Check if a model supports reasoning controls.
 */
export function supportsReasoning(model: string): boolean {
  return isValidModel(model) && model in MODEL_REASONING_CONFIG;
}

/**
 * Get reasoning configuration for a model, or undefined if not supported.
 */
export function getReasoningConfig(model: string): ModelReasoningConfig | undefined {
  if (!isValidModel(model)) return undefined;
  return MODEL_REASONING_CONFIG[model];
}

/**
 * Get the default reasoning effort for a model, or undefined if not supported.
 */
export function getDefaultReasoningEffort(model: string): ReasoningEffort | undefined {
  return getReasoningConfig(model)?.default;
}

/**
 * Check if a reasoning effort is valid for a given model.
 */
export function isValidReasoningEffort(model: string, effort: string): boolean {
  const config = getReasoningConfig(model);
  if (!config) return false;
  return config.efforts.includes(effort as ReasoningEffort);
}

/**
 * Extract provider and model from a model ID.
 *
 * Models with "/" have embedded provider (e.g., "openai/gpt-5.2-codex").
 * Models like "claude-haiku-4-5" use "anthropic" as default provider.
 *
 * @example
 * extractProviderAndModel("claude-haiku-4-5") // { provider: "anthropic", model: "claude-haiku-4-5" }
 * extractProviderAndModel("openai/gpt-5.2-codex") // { provider: "openai", model: "gpt-5.2-codex" }
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
