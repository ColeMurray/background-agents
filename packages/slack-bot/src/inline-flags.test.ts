import { describe, expect, it } from "vitest";
import type { ValidModel } from "@open-inspect/shared/models";
import { resolveInlinePromptOptions, threadFallbackModels } from "./inline-flags";

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

describe("resolveInlinePromptOptions fallback models", () => {
  const sessionDefaults = { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" };
  const enabledModels = ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] satisfies ValidModel[];

  it("replaces a disabled session model from every enabled model by default", () => {
    expect(
      resolveInlinePromptOptions({ reasoningEffort: "high" }, sessionDefaults, enabledModels)
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-5.4", reasoningEffort: "high" },
        effective: { model: "openai/gpt-5.4", reasoningEffort: "high" },
      },
    });
  });

  it("replaces a disabled session model from the fallback models", () => {
    expect(
      resolveInlinePromptOptions({ reasoningEffort: "max" }, sessionDefaults, enabledModels, [
        "anthropic/claude-haiku-4-5",
      ])
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "max" },
        effective: { model: "anthropic/claude-haiku-4-5", reasoningEffort: "max" },
      },
    });
  });

  it("accepts a !model that is enabled but not a fallback model", () => {
    expect(
      resolveInlinePromptOptions({ model: "openai/gpt-5.4" }, sessionDefaults, enabledModels, [
        "anthropic/claude-haiku-4-5",
      ])
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults,
        promptOverrides: { model: "openai/gpt-5.4", reasoningEffort: "high" },
        effective: { model: "openai/gpt-5.4", reasoningEffort: "high" },
      },
    });
  });

  it("keeps an enabled session model that is not a fallback model", () => {
    const openaiSession = { model: "openai/gpt-5.4", reasoningEffort: "high" };
    expect(
      resolveInlinePromptOptions({ reasoningEffort: "high" }, openaiSession, enabledModels, [
        "anthropic/claude-haiku-4-5",
      ])
    ).toEqual({
      ok: true,
      turnPlan: {
        sessionDefaults: openaiSession,
        promptOverrides: { reasoningEffort: "high" },
        effective: openaiSession,
      },
    });
  });
});

describe("threadFallbackModels", () => {
  const enabledModels = [
    "openai/gpt-5.4",
    "anthropic/claude-haiku-4-5",
    "xai/grok-4.7",
    "anthropic/claude-opus-4-8",
  ] satisfies ValidModel[];
  const nonAnthropicModels = ["openai/gpt-5.4", "xai/grok-4.7"] satisfies ValidModel[];

  it.each([
    ["every enabled model to a GPT thread", "openai/gpt-5.5", enabledModels, enabledModels],
    [
      "only the enabled Anthropic models to an Anthropic thread",
      "anthropic/claude-sonnet-4-6",
      enabledModels,
      ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-8"],
    ],
    [
      "every enabled model to an Anthropic thread when no Anthropic model is enabled",
      "anthropic/claude-sonnet-4-6",
      nonAnthropicModels,
      nonAnthropicModels,
    ],
  ])("offers %s", (_case, sessionModel, enabled, expected) => {
    expect(threadFallbackModels(sessionModel, enabled)).toEqual(expected);
  });

  it("decides by the stored model's provider even after it leaves the catalog", () => {
    expect(threadFallbackModels("openai/gpt-4o", enabledModels)).toEqual(enabledModels);
  });
});
