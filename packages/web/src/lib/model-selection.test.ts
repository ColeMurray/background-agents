import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared";
import { resolveEnabledModel, resolveModelPreference } from "./model-selection";

describe("resolveEnabledModel", () => {
  it("keeps the desired model when it is enabled", () => {
    expect(
      resolveEnabledModel("anthropic/claude-opus-4-8", ["anthropic/claude-opus-4-8", DEFAULT_MODEL])
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("normalizes a bare model id before checking the enabled set", () => {
    expect(resolveEnabledModel("claude-opus-4-8", ["anthropic/claude-opus-4-8"])).toBe(
      "anthropic/claude-opus-4-8"
    );
  });

  it("falls back to the default when the desired model is not enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", [DEFAULT_MODEL])).toBe(DEFAULT_MODEL);
  });

  it("falls back to the first enabled model when neither desired nor default is enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", ["openai/gpt-5.5"])).toBe(
      "openai/gpt-5.5"
    );
  });

  it("coerces an unknown model id to the enabled default", () => {
    expect(resolveEnabledModel("not-a-real-model", [DEFAULT_MODEL, "openai/gpt-5.5"])).toBe(
      DEFAULT_MODEL
    );
  });

  it("falls back to the default when no models are enabled", () => {
    expect(resolveEnabledModel("anthropic/claude-opus-4-8", [])).toBe(DEFAULT_MODEL);
  });
});

describe("resolveModelPreference", () => {
  it("keeps a valid model and reasoning effort", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" }, [
        "anthropic/claude-opus-4-8",
      ])
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("normalizes the model before validating reasoning effort", () => {
    expect(
      resolveModelPreference({ model: "claude-opus-4-8", reasoningEffort: "high" }, [
        "anthropic/claude-opus-4-8",
      ])
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("preserves the upstream model while enabled models are loading", () => {
    expect(
      resolveModelPreference({ model: "claude-opus-4-8", reasoningEffort: "high" }, undefined)
    ).toEqual({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  });

  it("uses the default when the loaded enabled-model list is empty", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" }, [])
    ).toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
    });
  });

  it("uses the fallback model default when reasoning is invalid", () => {
    expect(
      resolveModelPreference({ model: "anthropic/claude-opus-4-8", reasoningEffort: "not-valid" }, [
        DEFAULT_MODEL,
      ])
    ).toEqual({
      model: DEFAULT_MODEL,
      reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
    });
  });

  it("uses the selected model default when only reasoning is invalid", () => {
    const model = "anthropic/claude-opus-4-8";
    expect(resolveModelPreference({ model, reasoningEffort: "not-valid" }, [model])).toEqual({
      model,
      reasoningEffort: getDefaultReasoningEffort(model),
    });
  });

  it("omits reasoning for models without reasoning controls", () => {
    expect(
      resolveModelPreference({ model: "opencode/kimi-k2.5", reasoningEffort: "high" }, [
        "opencode/kimi-k2.5",
      ])
    ).toEqual({ model: "opencode/kimi-k2.5", reasoningEffort: undefined });
  });
});
