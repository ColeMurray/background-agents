import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  extractProviderAndModel,
  getDefaultReasoningEffort,
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  normalizeModelId,
  supportsReasoning,
} from "./models";

const ANTHROPIC_MODELS = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-fable-5",
] as const;

const OPENAI_MODELS = [
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
] as const;

const ZEN_MODELS = [
  "opencode/kimi-k2.5",
  "opencode/kimi-k2.6",
  "opencode/minimax-m2.5",
  "opencode/qwen3.7-max",
  "opencode/glm-5",
  "opencode/glm-5.1",
] as const;

const DEEPSEEK_MODELS = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"] as const;
const ZAI_CODING_PLAN_MODELS = ["zai-coding-plan/glm-5.2"] as const;

describe("model utilities", () => {
  it("keeps DEFAULT_MODEL valid", () => {
    expect(isValidModel(DEFAULT_MODEL)).toBe(true);
  });

  it("validates all supported provider-prefixed models", () => {
    for (const model of [
      ...ANTHROPIC_MODELS,
      ...OPENAI_MODELS,
      ...ZEN_MODELS,
      ...ZAI_CODING_PLAN_MODELS,
      ...DEEPSEEK_MODELS,
    ]) {
      expect(isValidModel(model)).toBe(true);
    }
  });

  it("normalizes and validates bare Claude and GPT model names", () => {
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
    expect(normalizeModelId("claude-opus-4-8")).toBe("anthropic/claude-opus-4-8");
    expect(normalizeModelId("claude-fable-5")).toBe("anthropic/claude-fable-5");
    expect(normalizeModelId("gpt-5.3-codex")).toBe("openai/gpt-5.3-codex");
    expect(normalizeModelId("gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(isValidModel("claude-sonnet-4-6")).toBe(true);
    expect(isValidModel("claude-opus-4-8")).toBe(true);
    expect(isValidModel("claude-fable-5")).toBe(true);
    expect(isValidModel("gpt-5.3-codex")).toBe(true);
    expect(isValidModel("gpt-5.6-sol")).toBe(true);
  });

  it("rejects invalid, legacy, empty, and case-mismatched models", () => {
    for (const model of ["gpt-4", "claude-3-opus", "claude-3-haiku", "haiku", "", "invalid"]) {
      expect(isValidModel(model)).toBe(false);
    }
    expect(isValidModel("Claude-Haiku-4-5")).toBe(false);
  });

  it("extracts providers and model names after normalization", () => {
    expect(extractProviderAndModel("anthropic/claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(extractProviderAndModel("claude-opus-4-8")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(extractProviderAndModel("openai/gpt-5.3-codex-spark")).toEqual({
      provider: "openai",
      model: "gpt-5.3-codex-spark",
    });
    expect(extractProviderAndModel("provider/model/version")).toEqual({
      provider: "provider",
      model: "model/version",
    });
    expect(extractProviderAndModel("unknown-model")).toEqual({
      provider: "anthropic",
      model: "unknown-model",
    });
  });

  it("returns canonical valid models or the default fallback", () => {
    expect(getValidModelOrDefault("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
    expect(getValidModelOrDefault("gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
    expect(getValidModelOrDefault("invalid-model")).toBe(DEFAULT_MODEL);
    expect(getValidModelOrDefault(undefined)).toBe(DEFAULT_MODEL);
    expect(getValidModelOrDefault(null)).toBe(DEFAULT_MODEL);
    expect(getValidModelOrDefault("")).toBe(DEFAULT_MODEL);
  });

  it("reports reasoning support and default efforts", () => {
    expect(supportsReasoning("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(supportsReasoning("claude-opus-4-8")).toBe(true);
    expect(supportsReasoning("openai/gpt-5.2")).toBe(true);
    expect(supportsReasoning("openai/gpt-5.6-terra")).toBe(true);
    expect(supportsReasoning("deepseek/deepseek-v4-flash")).toBe(false);
    expect(supportsReasoning("invalid")).toBe(false);

    expect(getDefaultReasoningEffort("anthropic/claude-haiku-4-5")).toBe("max");
    expect(getDefaultReasoningEffort("anthropic/claude-sonnet-4-6")).toBe("high");
    expect(getDefaultReasoningEffort("anthropic/claude-opus-4-8")).toBe("high");
    expect(getDefaultReasoningEffort("anthropic/claude-fable-5")).toBe("high");
    expect(getDefaultReasoningEffort("openai/gpt-5.3-codex")).toBe("high");
    expect(getDefaultReasoningEffort("openai/gpt-5.5")).toBeUndefined();
    expect(getDefaultReasoningEffort("openai/gpt-5.6-luna")).toBeUndefined();
    expect(getDefaultReasoningEffort("deepseek/deepseek-v4-pro")).toBeUndefined();
  });

  it("returns reasoning configurations for supported model families", () => {
    expect(getReasoningConfig("anthropic/claude-sonnet-4-5")).toEqual({
      efforts: ["high", "max"],
      default: "max",
    });
    expect(getReasoningConfig("anthropic/claude-sonnet-4-6")).toEqual({
      efforts: ["low", "medium", "high", "max"],
      default: "high",
    });
    expect(getReasoningConfig("anthropic/claude-opus-4-8")).toEqual({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    });
    expect(getReasoningConfig("openai/gpt-5.2")).toEqual({
      efforts: ["none", "low", "medium", "high", "xhigh"],
      default: undefined,
    });
    expect(getReasoningConfig("openai/gpt-5.6-sol")).toEqual({
      efforts: ["none", "low", "medium", "high", "xhigh"],
      default: undefined,
    });
    expect(getReasoningConfig("openai/gpt-5.2-codex")).toEqual({
      efforts: ["low", "medium", "high", "xhigh"],
      default: "high",
    });
    expect(getReasoningConfig("deepseek/deepseek-v4-flash")).toBeUndefined();
  });

  it("validates reasoning efforts per model", () => {
    expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "high")).toBe(true);
    expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "low")).toBe(false);
    expect(isValidReasoningEffort("anthropic/claude-opus-4-8", "xhigh")).toBe(true);
    expect(isValidReasoningEffort("anthropic/claude-opus-4-8", "none")).toBe(false);
    expect(isValidReasoningEffort("anthropic/claude-fable-5", "max")).toBe(true);
    expect(isValidReasoningEffort("openai/gpt-5.2", "none")).toBe(true);
    expect(isValidReasoningEffort("openai/gpt-5.6-sol", "xhigh")).toBe(true);
    expect(isValidReasoningEffort("openai/gpt-5.6-sol", "max")).toBe(false);
    expect(isValidReasoningEffort("openai/gpt-5.2-codex", "max")).toBe(false);
    expect(isValidReasoningEffort("deepseek/deepseek-v4-pro", "high")).toBe(false);
    expect(isValidReasoningEffort("invalid", "high")).toBe(false);
    expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "")).toBe(false);
  });

  it("groups display options and excludes opt-in providers from default enabled models", () => {
    expect(
      MODEL_OPTIONS.find((group) => group.category === "Anthropic")?.models.map((m) => m.id)
    ).toEqual(ANTHROPIC_MODELS);
    expect(
      MODEL_OPTIONS.find((group) => group.category === "OpenAI")?.models.map((m) => m.id)
    ).toEqual(OPENAI_MODELS);
    expect(
      MODEL_OPTIONS.find((group) => group.category === "OpenCode Zen")?.models.map((m) => m.id)
    ).toEqual(ZEN_MODELS);
    expect(
      MODEL_OPTIONS.find((group) => group.category === "Z.AI Coding Plan")?.models.map((m) => m.id)
    ).toEqual(ZAI_CODING_PLAN_MODELS);
    expect(
      MODEL_OPTIONS.find((group) => group.category === "DeepSeek")?.models.map((m) => m.id)
    ).toEqual(DEEPSEEK_MODELS);

    expect(DEFAULT_ENABLED_MODELS).toEqual([...ANTHROPIC_MODELS, ...OPENAI_MODELS]);
    for (const optInModel of [...ZEN_MODELS, ...ZAI_CODING_PLAN_MODELS, ...DEEPSEEK_MODELS]) {
      expect(DEFAULT_ENABLED_MODELS).not.toContain(optInModel);
    }
  });
});
