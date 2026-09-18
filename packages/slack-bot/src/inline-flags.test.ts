import { describe, expect, it } from "vitest";
import { parseInlinePromptFlags, resolveInlinePromptOptions } from "./inline-flags";

describe("parseInlinePromptFlags", () => {
  it("parses model and reasoning flags in either supported form", () => {
    expect(
      parseInlinePromptFlags(
        "!model openai/gpt-5.6-sol !reasoning:high investigate the failing test"
      )
    ).toEqual({
      ok: true,
      text: "investigate the failing test",
      options: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    });
    expect(parseInlinePromptFlags("!reasoning low !model:claude-sonnet-4-6 fix it")).toEqual({
      ok: true,
      text: "fix it",
      options: { model: "claude-sonnet-4-6", reasoningEffort: "low" },
    });
  });

  it("only treats a contiguous leading prefix as flags", () => {
    expect(parseInlinePromptFlags("fix docs mentioning !model openai/gpt-5.6-sol")).toEqual({
      ok: true,
      text: "fix docs mentioning !model openai/gpt-5.6-sol",
      options: {},
    });
    expect(parseInlinePromptFlags("!unknown !model openai/gpt-5.6-sol fix it")).toEqual({
      ok: true,
      text: "!unknown !model openai/gpt-5.6-sol fix it",
      options: {},
    });
  });

  it("rejects missing and duplicate values", () => {
    expect(parseInlinePromptFlags("!model")).toEqual({
      ok: false,
      error: "The !model flag requires a value.",
    });
    expect(parseInlinePromptFlags("!reasoning high !reasoning low fix it")).toEqual({
      ok: false,
      error: "The !reasoning flag can only be specified once.",
    });
  });
});

describe("resolveInlinePromptOptions", () => {
  const defaults = { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" };
  const enabledModels = ["anthropic/claude-sonnet-4-6", "openai/gpt-5.6-sol"];

  it("resolves combined overrides against the inline model", () => {
    expect(
      resolveInlinePromptOptions(
        { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: true,
      promptOverrides: { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
      effectiveModel: "openai/gpt-5.6-sol",
      effectiveReasoningEffort: "xhigh",
    });
  });

  it("normalizes bare model ids and preserves a compatible default effort", () => {
    expect(resolveInlinePromptOptions({ model: "gpt-5.6-sol" }, defaults, enabledModels)).toEqual({
      ok: true,
      promptOverrides: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
      effectiveModel: "openai/gpt-5.6-sol",
      effectiveReasoningEffort: "high",
    });
  });

  it("rejects disabled models and incompatible reasoning", () => {
    expect(
      resolveInlinePromptOptions({ model: "openai/gpt-5.5" }, defaults, enabledModels)
    ).toEqual({ ok: false, error: 'Model "openai/gpt-5.5" is not enabled.' });
    expect(resolveInlinePromptOptions({ reasoningEffort: "max" }, defaults, enabledModels)).toEqual(
      {
        ok: true,
        promptOverrides: { reasoningEffort: "max" },
        effectiveModel: "anthropic/claude-sonnet-4-6",
        effectiveReasoningEffort: "max",
      }
    );
    expect(
      resolveInlinePromptOptions(
        { model: "openai/gpt-5.6-sol", reasoningEffort: "max" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: false,
      error:
        'Reasoning effort "max" is not valid for "openai/gpt-5.6-sol". Supported values: none, low, medium, high, xhigh.',
    });
  });
});
