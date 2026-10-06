/**
 * Parser for the `!model` and `!reasoning` flags users can put at the start of
 * a bot request (a Slack message or a GitHub `@mention` comment). Parsing is
 * shared so every integration accepts the same grammar; each integration
 * decides how the parsed values are validated and applied.
 */

export interface InlinePromptOptions {
  model?: string;
  reasoningEffort?: string;
}

export const EMPTY_INLINE_PROMPT_OPTIONS: InlinePromptOptions = {};

export type ParseInlinePromptFlagsResult =
  | { ok: true; text: string; options: InlinePromptOptions }
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

/** Parse a contiguous prefix of model and reasoning flags. */
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
