/**
 * Centralized model definitions and reasoning configuration.
 *
 * All packages import model-related types and validation from here
 * to ensure consistent behavior across control plane, web UI, and Slack bot.
 */

/**
 * Valid model names supported by the system.
 * All models use "provider/model" format.
 */
export const VALID_MODELS = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4-5",
  "openai/gpt-5.2",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
] as const;

export type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Default model to use when none specified or invalid.
 */
export const DEFAULT_MODEL: ValidModel = "anthropic/claude-haiku-4-5";

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
  "anthropic/claude-haiku-4-5": { efforts: ["high", "max"], default: "max" },
  "anthropic/claude-sonnet-4-5": { efforts: ["high", "max"], default: "max" },
  "anthropic/claude-opus-4-5": { efforts: ["high", "max"], default: "max" },
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
      {
        id: "anthropic/claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        description: "Fast and efficient",
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Balanced performance",
      },
      {
        id: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5",
        description: "Most capable",
      },
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

// === Normalization ===

/**
 * Normalize a model ID to canonical "provider/model" format.
 * Adds "anthropic/" prefix to bare Claude model names for backward compat
 * with existing data in D1, SQLite, and Slack KV.
 */
export function normalizeModelId(modelId: string): string {
  if (modelId.includes("/")) return modelId;
  if (modelId.startsWith("claude-")) return `anthropic/${modelId}`;
  return modelId;
}

// === Validation helpers ===

/**
 * Check if a model name is valid.
 * Accepts both prefixed ("anthropic/claude-haiku-4-5") and bare ("claude-haiku-4-5") formats.
 */
export function isValidModel(model: string): model is ValidModel {
  return VALID_MODELS.includes(normalizeModelId(model) as ValidModel);
}

/**
 * Check if a model supports reasoning controls.
 */
export function supportsReasoning(model: string): boolean {
  return getReasoningConfig(model) !== undefined;
}

/**
 * Get reasoning configuration for a model, or undefined if not supported.
 */
export function getReasoningConfig(model: string): ModelReasoningConfig | undefined {
  const normalized = normalizeModelId(model);
  if (!isValidModel(normalized)) return undefined;
  return MODEL_REASONING_CONFIG[normalized as ValidModel];
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
 * Normalizes bare Claude model names first, then splits on "/".
 *
 * @example
 * extractProviderAndModel("anthropic/claude-haiku-4-5") // { provider: "anthropic", model: "claude-haiku-4-5" }
 * extractProviderAndModel("claude-haiku-4-5") // { provider: "anthropic", model: "claude-haiku-4-5" }
 * extractProviderAndModel("openai/gpt-5.2-codex") // { provider: "openai", model: "gpt-5.2-codex" }
 */
export function extractProviderAndModel(modelId: string): { provider: string; model: string } {
  const normalized = normalizeModelId(modelId);
  if (normalized.includes("/")) {
    const [provider, ...modelParts] = normalized.split("/");
    return { provider, model: modelParts.join("/") };
  }
  // Fallback for truly unknown models
  return { provider: "anthropic", model: normalized };
}

/**
 * Get a valid model or fall back to default.
 * Accepts both prefixed and bare formats; always returns canonical prefixed format.
 */
export function getValidModelOrDefault(model: string | undefined | null): ValidModel {
  if (model && isValidModel(model)) {
    return normalizeModelId(model) as ValidModel;
  }
  return DEFAULT_MODEL;
}
