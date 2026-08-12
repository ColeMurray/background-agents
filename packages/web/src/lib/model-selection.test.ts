import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared/models";
import { resolveModelPreference } from "./model-selection";

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
