/**
 * Centralized model definitions and reasoning configuration.
 *
 * All packages import model-related types and validation from here
 * to ensure consistent behavior across control plane, web UI, and Slack bot.
 */

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
 * Authoritative model metadata, grouped in UI display order.
 */
export const MODEL_CATALOG = [
  {
    category: "Anthropic",
    enabledByDefault: true,
    models: [
      {
        id: "anthropic/claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        description: "Fast and efficient",
        reasoning: { efforts: ["high", "max"], default: "max" },
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Balanced performance",
        reasoning: { efforts: ["high", "max"], default: "max" },
      },
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Latest balanced, fast coding",
        default: true,
        reasoning: { efforts: ["low", "medium", "high", "max"], default: "high" },
      },
      {
        id: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5",
        description: "Most capable",
        reasoning: { efforts: ["high", "max"], default: "max" },
      },
      {
        id: "anthropic/claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Most capable, adaptive thinking",
        reasoning: { efforts: ["low", "medium", "high", "max"], default: "high" },
      },
      {
        id: "anthropic/claude-opus-4-7",
        name: "Claude Opus 4.7",
        description: "Most capable, adaptive thinking",
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      },
      {
        id: "anthropic/claude-opus-4-8",
        name: "Claude Opus 4.8",
        description: "Most capable, adaptive thinking",
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      },
      {
        id: "anthropic/claude-fable-5",
        name: "Claude Fable 5",
        description: "Most powerful, new tier above Opus",
        reasoning: {
          efforts: ["low", "medium", "high", "xhigh", "max"],
          default: "high",
        },
      },
    ],
  },
  {
    category: "OpenAI",
    enabledByDefault: true,
    models: [
      {
        id: "openai/gpt-5.4",
        name: "GPT 5.4",
        description: "Flagship model",
        reasoning: {
          efforts: ["none", "low", "medium", "high", "xhigh"],
          default: undefined,
        },
      },
      {
        id: "openai/gpt-5.5",
        name: "GPT 5.5",
        description: "Latest flagship model",
        reasoning: {
          efforts: ["none", "low", "medium", "high", "xhigh"],
          default: undefined,
        },
      },
      {
        id: "openai/gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        description: "Frontier model for complex professional work",
        reasoning: {
          efforts: ["none", "low", "medium", "high", "xhigh"],
          default: undefined,
        },
      },
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        description: "Balanced, cost-efficient everyday work",
        reasoning: {
          efforts: ["none", "low", "medium", "high", "xhigh"],
          default: undefined,
        },
      },
      {
        id: "openai/gpt-5.6-luna",
        name: "GPT 5.6 Luna",
        description: "Fast, cost-efficient high-volume workloads",
        reasoning: {
          efforts: ["none", "low", "medium", "high", "xhigh"],
          default: undefined,
        },
      },
      {
        id: "openai/gpt-5.3-codex",
        name: "GPT 5.3 Codex",
        description: "Latest codex",
        reasoning: { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
      },
      {
        id: "openai/gpt-5.3-codex-spark",
        name: "GPT 5.3 Codex Spark",
        description: "Low-latency codex variant",
        reasoning: { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
      },
    ],
  },
  {
    category: "OpenCode Zen",
    enabledByDefault: false,
    models: [
      { id: "opencode/kimi-k2.5", name: "Kimi K2.5", description: "Moonshot AI" },
      { id: "opencode/kimi-k2.6", name: "Kimi K2.6", description: "Moonshot AI" },
      { id: "opencode/minimax-m2.5", name: "MiniMax M2.5", description: "MiniMax" },
      { id: "opencode/qwen3.7-max", name: "Qwen3.7 Max", description: "Alibaba Cloud" },
      { id: "opencode/glm-5", name: "GLM 5", description: "Z.ai 744B MoE" },
      { id: "opencode/glm-5.1", name: "GLM 5.1", description: "Z.ai" },
    ],
  },
  {
    category: "Z.AI Coding Plan",
    enabledByDefault: false,
    models: [{ id: "zai-coding-plan/glm-5.2", name: "GLM 5.2", description: "Z.AI Coding Plan" }],
  },
  {
    category: "DeepSeek",
    enabledByDefault: false,
    models: [
      { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fast model" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Most capable" },
    ],
  },
] as const;

export type ValidModel = (typeof MODEL_CATALOG)[number]["models"][number]["id"];

type CatalogModel = (typeof MODEL_CATALOG)[number]["models"][number];
const MODEL_DEFINITIONS: readonly CatalogModel[] = MODEL_CATALOG.flatMap((group) => [
  ...group.models,
]);

/** Valid model names supported by the system, in UI display order. */
export const VALID_MODELS: ValidModel[] = MODEL_DEFINITIONS.map((model) => model.id);

/** Default model to use when none is specified or valid. */
export const DEFAULT_MODEL: ValidModel = MODEL_DEFINITIONS.find(
  (model) => "default" in model && model.default
)!.id;

/** Per-model reasoning configuration. Models omitted do not support reasoning controls. */
export const MODEL_REASONING_CONFIG: Partial<Record<ValidModel, ModelReasoningConfig>> =
  Object.fromEntries(
    MODEL_CATALOG.flatMap((group) =>
      group.models.flatMap((model) =>
        "reasoning" in model
          ? [
              [
                model.id,
                { efforts: [...model.reasoning.efforts], default: model.reasoning.default },
              ],
            ]
          : []
      )
    )
  );

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
  ...MODEL_CATALOG.map((group) => ({
    category: group.category,
    models: group.models.map(({ id, name, description }) => ({ id, name, description })),
  })),
];

/**
 * Models enabled by default when no preferences are stored.
 * Excludes opt-in providers which must be enabled via settings.
 */
export const DEFAULT_ENABLED_MODELS: ValidModel[] = MODEL_CATALOG.filter(
  (group) => group.enabledByDefault
).flatMap((group) => group.models.map((model) => model.id));

// === Normalization ===

/**
 * Normalize a model ID to canonical "provider/model" format.
 * Adds "anthropic/" prefix to bare Claude model names and "openai/" prefix
 * to bare GPT model names for backward compat with existing data in D1,
 * SQLite, and Slack KV.
 */
export function normalizeModelId(modelId: string): string {
  if (modelId.includes("/")) return modelId;
  if (modelId.startsWith("claude-")) return `anthropic/${modelId}`;
  if (modelId.startsWith("gpt-")) return `openai/${modelId}`;
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
 * extractProviderAndModel("openai/gpt-5.3-codex") // { provider: "openai", model: "gpt-5.3-codex" }
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
