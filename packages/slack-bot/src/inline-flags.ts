import {
  getDefaultReasoningEffort,
  getReasoningConfig,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
} from "@open-inspect/shared/models";

export interface InlinePromptOptions {
  model?: string;
  reasoningEffort?: string;
}

export const EMPTY_INLINE_PROMPT_OPTIONS: InlinePromptOptions = {};

export type ParseInlinePromptFlagsResult =
  | { ok: true; text: string; options: InlinePromptOptions }
  | { ok: false; error: string };

export type ResolveInlinePromptOptionsResult =
  | {
      ok: true;
      promptOverrides: InlinePromptOptions;
      effectiveModel: string;
      effectiveReasoningEffort?: string;
    }
  | { ok: false; error: string };

const FLAG_NAMES = ["model", "reasoning"] as const;
type FlagName = (typeof FLAG_NAMES)[number];

function readFlag(text: string): { name: FlagName; value: string; length: number } | null {
  for (const name of FLAG_NAMES) {
    const colonPrefix = `!${name}:`;
    if (text.startsWith(colonPrefix)) {
      const value = text.slice(colonPrefix.length).match(/^\S*/)?.[0] ?? "";
      return { name, value, length: colonPrefix.length + value.length };
    }

    const spacePrefix = `!${name}`;
    if (text === spacePrefix || text.startsWith(`${spacePrefix} `)) {
      const afterName = text.slice(spacePrefix.length);
      const whitespaceLength = afterName.match(/^\s*/)?.[0].length ?? 0;
      const value = afterName.slice(whitespaceLength).match(/^\S*/)?.[0] ?? "";
      return {
        name,
        value,
        length: spacePrefix.length + whitespaceLength + value.length,
      };
    }
  }
  return null;
}

/** Parse a contiguous prefix of Slack-only model and reasoning controls. */
export function parseInlinePromptFlags(text: string): ParseInlinePromptFlagsResult {
  let remaining = text.trimStart();
  const options: InlinePromptOptions = {};

  while (remaining) {
    const flag = readFlag(remaining);
    if (!flag) break;
    if (!flag.value || flag.value.startsWith("!")) {
      return { ok: false, error: `The !${flag.name} flag requires a value.` };
    }

    const field = flag.name === "model" ? "model" : "reasoningEffort";
    if (options[field]) {
      return { ok: false, error: `The !${flag.name} flag can only be specified once.` };
    }
    options[field] = flag.value;
    remaining = remaining.slice(flag.length).trimStart();
  }

  return { ok: true, text: remaining.trim(), options };
}

export function hasInlinePromptOptions(options: InlinePromptOptions): boolean {
  return options.model !== undefined || options.reasoningEffort !== undefined;
}

/** Resolve one-turn overrides against the session defaults and enabled model list. */
export function resolveInlinePromptOptions(
  options: InlinePromptOptions,
  defaults: { model: string; reasoningEffort?: string },
  enabledModels: readonly string[]
): ResolveInlinePromptOptionsResult {
  let modelOverride: string | undefined;
  if (options.model) {
    if (!isValidModel(options.model)) {
      return { ok: false, error: `Unknown model "${options.model}".` };
    }
    modelOverride = normalizeModelId(options.model);
    if (!enabledModels.some((model) => normalizeModelId(model) === modelOverride)) {
      return { ok: false, error: `Model "${modelOverride}" is not enabled.` };
    }
  }

  const effectiveModel = modelOverride ?? defaults.model;
  if (options.reasoningEffort && !isValidReasoningEffort(effectiveModel, options.reasoningEffort)) {
    const efforts = getReasoningConfig(effectiveModel)?.efforts;
    const suffix = efforts?.length
      ? ` Supported values: ${efforts.join(", ")}.`
      : " This model does not support reasoning controls.";
    return {
      ok: false,
      error: `Reasoning effort "${options.reasoningEffort}" is not valid for "${effectiveModel}".${suffix}`,
    };
  }

  const effectiveReasoningEffort = options.reasoningEffort
    ? options.reasoningEffort
    : modelOverride
      ? defaults.reasoningEffort && isValidReasoningEffort(modelOverride, defaults.reasoningEffort)
        ? defaults.reasoningEffort
        : getDefaultReasoningEffort(modelOverride)
      : defaults.reasoningEffort;

  return {
    ok: true,
    promptOverrides: {
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(options.reasoningEffort || modelOverride
        ? { reasoningEffort: effectiveReasoningEffort }
        : {}),
    },
    effectiveModel,
    effectiveReasoningEffort,
  };
}
