import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL } from "@open-inspect/shared";
import { resolveEnabledModel } from "./model-selection";

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
