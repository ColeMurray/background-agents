import { describe, it, expect } from "vitest";
import { resolveSessionModelSettings } from "./model-resolution";

const ENV_DEFAULT = "anthropic/claude-sonnet-4-6";

describe("resolveSessionModelSettings", () => {
  it("falls back to env default when config has no model", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: null,
      configReasoningEffort: null,
      allowInlineDirectiveOverride: true,
    });
    expect(result).toEqual({ model: ENV_DEFAULT, reasoningEffort: null });
  });

  it("uses config model when provided", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
    });
    expect(result).toEqual({
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
    });
  });

  it("priority: directive model overrides config model", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
      directiveModel: "anthropic/claude-opus-4-7",
      directiveReasoningEffort: "max",
    });
    expect(result).toEqual({
      model: "anthropic/claude-opus-4-7",
      reasoningEffort: "max",
    });
  });

  it("priority: config model overrides env default", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-opus-4-6",
      configReasoningEffort: null,
      allowInlineDirectiveOverride: true,
    });
    expect(result.model).toBe("anthropic/claude-opus-4-6");
  });

  it("allowInlineDirectiveOverride=false ignores directive entirely", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "max",
      allowInlineDirectiveOverride: false,
      directiveModel: "anthropic/claude-opus-4-7",
      directiveReasoningEffort: "low",
    });
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "max",
    });
  });

  it("directive supplies only reasoning: model from config, reasoning applied if compatible", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-opus-4-7",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
      directiveReasoningEffort: "max",
    });
    expect(result).toEqual({
      model: "anthropic/claude-opus-4-7",
      reasoningEffort: "max",
    });
  });

  it("directive supplies only reasoning, but reasoning incompatible with config model: falls back to config reasoning", () => {
    // claude-sonnet-4-5 supports only "high" and "max"
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-sonnet-4-5",
      configReasoningEffort: "max",
      allowInlineDirectiveOverride: true,
      directiveReasoningEffort: "low",
    });
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: "max",
    });
  });

  it("directive model with incompatible reasoning: model wins, reasoning becomes null", () => {
    // claude-sonnet-4-5 supports only "high" and "max"
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-opus-4-7",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
      directiveModel: "anthropic/claude-sonnet-4-5",
      directiveReasoningEffort: "low",
    });
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      reasoningEffort: null,
    });
  });

  it("directive model with no directive reasoning: drops config reasoning entirely", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-opus-4-7",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
      directiveModel: "anthropic/claude-sonnet-4-6",
    });
    // Reasoning is not carried from config when directive supplied a fresh model.
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
    });
  });

  it("config reasoning incompatible with config model: reasoning becomes null", () => {
    // claude-haiku-4-5 supports only "high" and "max"
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-haiku-4-5",
      configReasoningEffort: "low",
      allowInlineDirectiveOverride: true,
    });
    expect(result).toEqual({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
    });
  });

  it("invalid directive model is treated as no directive model", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "anthropic/claude-sonnet-4-6",
      configReasoningEffort: "high",
      allowInlineDirectiveOverride: true,
      directiveModel: "totally-not-a-model",
    });
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
    });
  });

  it("invalid config model falls back to env default via getValidModelOrDefault", () => {
    const result = resolveSessionModelSettings({
      envDefaultModel: ENV_DEFAULT,
      configModel: "bogus/model",
      configReasoningEffort: null,
      allowInlineDirectiveOverride: true,
    });
    expect(result.model).toBe(ENV_DEFAULT);
  });
});
