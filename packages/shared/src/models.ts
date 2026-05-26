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
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-7",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
  "opencode/kimi-k2.5",
  "opencode/minimax-m2.5",
  "opencode/glm-5",
] as const;

export type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Default model to use when none specified or invalid.
 */
export const DEFAULT_MODEL: ValidModel = "anthropic/claude-sonnet-4-6";

/**
 * Default model used for plan-mode planning turns.
 *
 * Distinct from DEFAULT_MODEL: planning benefits from a more capable model
 * since the resulting plan steers the subsequent implementation. The
 * implementation phase falls back to DEFAULT_MODEL (or the user's chosen
 * implementation model at approval time).
 */
export const DEFAULT_PLAN_MODEL: ValidModel = "anthropic/claude-opus-4-6";

/**
 * Map from short alias used in labels to the canonical provider/model
 * identifier. Used by Linear/GitHub label parsing — labels are dash-separated
 * (Linear forbids `:` in label names, so we unified on dashes everywhere):
 * `model-<alias>`, `plan-<alias>`, `build-<alias>`, `review-<alias>`.
 *
 * Keep aliases short and memorable — they are user-facing.
 */
export const MODEL_ALIAS_MAP: Record<string, ValidModel> = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-5",
  "opus-4-6": "anthropic/claude-opus-4-6",
  "opus-4-7": "anthropic/claude-opus-4-7",
  "gpt-5.2": "openai/gpt-5.2",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.2-codex": "openai/gpt-5.2-codex",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
};

/**
 * Parse a plan approve/reject command from a comment body (after any bot
 * @mention has been stripped). Returns `null` when the body is a regular
 * follow-up message.
 *
 * Recognized forms (case-insensitive, leading whitespace ignored):
 *   - `approve`            — accept the current plan; impl uses session.model
 *     (set from the `model-<alias>` label at session creation, else default)
 *   - `reject`             — discard the plan; session pauses
 *   - `reject <reason>`    — reason captured as the trailing text
 *
 * The implementation model is decided by labels at session-creation time,
 * not by an inline override here, so there is intentionally no per-approve
 * model picker via comments. Web and Slack expose their own picker UI.
 *
 * Shared between the Linear and GitHub bots so command syntax stays in sync.
 */
export type PlanCommand = { command: "approve" } | { command: "reject"; reason: string | null };

export function parsePlanCommand(body: string): PlanCommand | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  if (/^approve\s*$/i.test(trimmed)) {
    return { command: "approve" };
  }

  const rejectMatch = trimmed.match(/^reject(?:\s+(.*))?$/is);
  if (rejectMatch) {
    const reason = rejectMatch[1]?.trim();
    return { command: "reject", reason: reason && reason.length > 0 ? reason : null };
  }

  return null;
}

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
  "anthropic/claude-sonnet-4-6": { efforts: ["low", "medium", "high", "max"], default: "high" },
  "anthropic/claude-opus-4-5": { efforts: ["high", "max"], default: "max" },
  "anthropic/claude-opus-4-6": { efforts: ["low", "medium", "high", "max"], default: "high" },
  "anthropic/claude-opus-4-7": { efforts: ["low", "medium", "high", "max"], default: "high" },
  "openai/gpt-5.2": { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
  "openai/gpt-5.4": { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
  "openai/gpt-5.5": { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
  "openai/gpt-5.2-codex": { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
  "openai/gpt-5.3-codex": { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
  "openai/gpt-5.3-codex-spark": { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
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
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Latest balanced, fast coding",
      },
      {
        id: "anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5",
        description: "Most capable",
      },
      {
        id: "anthropic/claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Most capable, adaptive thinking",
      },
      {
        id: "anthropic/claude-opus-4-7",
        name: "Claude Opus 4.7",
        description: "Latest, most capable",
      },
    ],
  },
  {
    category: "OpenAI",
    models: [
      { id: "openai/gpt-5.2", name: "GPT 5.2", description: "400K context, fast" },
      { id: "openai/gpt-5.4", name: "GPT 5.4", description: "Flagship model" },
      { id: "openai/gpt-5.5", name: "GPT 5.5", description: "Latest flagship model" },
      { id: "openai/gpt-5.2-codex", name: "GPT 5.2 Codex", description: "Optimized for code" },
      { id: "openai/gpt-5.3-codex", name: "GPT 5.3 Codex", description: "Latest codex" },
      {
        id: "openai/gpt-5.3-codex-spark",
        name: "GPT 5.3 Codex Spark",
        description: "Low-latency codex variant",
      },
    ],
  },
  {
    category: "OpenCode Zen",
    models: [
      { id: "opencode/kimi-k2.5", name: "Kimi K2.5", description: "Moonshot AI" },
      { id: "opencode/minimax-m2.5", name: "MiniMax M2.5", description: "MiniMax" },
      { id: "opencode/glm-5", name: "GLM 5", description: "Z.ai 744B MoE" },
    ],
  },
];

/**
 * Models enabled by default when no preferences are stored.
 * Excludes zen models which must be opted into via settings.
 */
export const DEFAULT_ENABLED_MODELS: ValidModel[] = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-7",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
];

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
