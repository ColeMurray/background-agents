import { describe, expect, it } from "vitest";
import type { ValidModel } from "@open-inspect/shared/models";
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
  const enabledModels = [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.6-sol",
  ] satisfies ValidModel[];
  const sessionDefaults = {
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
  };

  it("resolves combined overrides against the inline model", () => {
    expect(
      resolveInlinePromptOptions(
        { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
        defaults,
        enabledModels
      )
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
        effective: { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
      },
    });
  });

  it("normalizes bare model ids and preserves a compatible default effort", () => {
    expect(resolveInlinePromptOptions({ model: "gpt-5.6-sol" }, defaults, enabledModels)).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
        effective: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
      },
    });
  });

  it("falls back from a disabled session model before applying a reasoning override", () => {
    expect(
      resolveInlinePromptOptions(
        { reasoningEffort: "max" },
        { model: "openai/gpt-5.6-sol", reasoningEffort: "xhigh" },
        ["anthropic/claude-sonnet-4-6"]
      )
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults: {
          model: "openai/gpt-5.6-sol",
          reasoningEffort: "xhigh",
        },
        promptOverrides: {
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "max",
        },
        effective: {
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "max",
        },
      },
    });
  });

  it("rejects disabled models and incompatible reasoning", () => {
    expect(
      resolveInlinePromptOptions({ model: "openai/gpt-5.5" }, defaults, enabledModels)
    ).toEqual({ ok: false, error: 'Model "openai/gpt-5.5" is not enabled.' });
    expect(resolveInlinePromptOptions({ reasoningEffort: "max" }, defaults, enabledModels)).toEqual(
      {
        ok: true,
        turnPlan: {
          sessionDefaults,
          promptOverrides: { reasoningEffort: "max" },
          effective: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "max" },
        },
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

  it("escapes Slack control tokens in validation errors", () => {
    expect(resolveInlinePromptOptions({ model: "<!channel>" }, defaults, enabledModels)).toEqual({
      ok: false,
      error: 'Unknown model "&lt;!channel&gt;".',
    });
    expect(
      resolveInlinePromptOptions({ reasoningEffort: "<@U123>" }, defaults, enabledModels)
    ).toEqual({
      ok: false,
      error:
        'Reasoning effort "&lt;@U123&gt;" is not valid for "anthropic/claude-sonnet-4-6". Supported values: low, medium, high, max.',
    });
  });
});
