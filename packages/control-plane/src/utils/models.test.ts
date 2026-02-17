import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL,
  normalizeModelId,
  isValidModel,
  extractProviderAndModel,
  getValidModelOrDefault,
  supportsReasoning,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  getReasoningConfig,
} from "./models";

describe("model utilities", () => {
  describe("DEFAULT_MODEL", () => {
    it("is a valid model", () => {
      expect(isValidModel(DEFAULT_MODEL)).toBe(true);
    });
  });

  describe("isValidModel", () => {
    it("returns true for valid models", () => {
      expect(isValidModel("anthropic/claude-haiku-4-5")).toBe(true);
      expect(isValidModel("anthropic/claude-sonnet-4-5")).toBe(true);
      expect(isValidModel("anthropic/claude-opus-4-5")).toBe(true);
    });

    it("accepts bare Claude model names via normalization", () => {
      expect(isValidModel("claude-haiku-4-5")).toBe(true);
      expect(isValidModel("claude-sonnet-4-5")).toBe(true);
      expect(isValidModel("claude-opus-4-5")).toBe(true);
    });

    it("returns true for OpenAI models", () => {
      expect(isValidModel("openai/gpt-5.2")).toBe(true);
      expect(isValidModel("openai/gpt-5.2-codex")).toBe(true);
      expect(isValidModel("openai/gpt-5.3-codex")).toBe(true);
    });

    it("returns false for invalid models", () => {
      expect(isValidModel("gpt-4")).toBe(false);
      expect(isValidModel("claude-3-opus")).toBe(false);
      expect(isValidModel("haiku")).toBe(false);
      expect(isValidModel("")).toBe(false);
      expect(isValidModel("invalid")).toBe(false);
    });

    it("is case-sensitive", () => {
      expect(isValidModel("Claude-Haiku-4-5")).toBe(false);
      expect(isValidModel("CLAUDE-HAIKU-4-5")).toBe(false);
    });

    it("handles legacy model names", () => {
      // Old model names should not be valid
      expect(isValidModel("claude-3-haiku")).toBe(false);
      expect(isValidModel("claude-3-5-sonnet")).toBe(false);
    });
  });

  describe("extractProviderAndModel", () => {
    it("extracts provider and model from slash-separated format", () => {
      const result = extractProviderAndModel("anthropic/claude-3-opus");

      expect(result).toEqual({
        provider: "anthropic",
        model: "claude-3-opus",
      });
    });

    it("handles multiple slashes (joins remaining parts)", () => {
      const result = extractProviderAndModel("provider/model/version");

      expect(result).toEqual({
        provider: "provider",
        model: "model/version",
      });
    });

    it("defaults to anthropic for models without slash", () => {
      const result = extractProviderAndModel("claude-haiku-4-5");

      expect(result).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      });
    });

    it("extracts openai provider from OpenAI models", () => {
      expect(extractProviderAndModel("openai/gpt-5.2")).toEqual({
        provider: "openai",
        model: "gpt-5.2",
      });

      expect(extractProviderAndModel("openai/gpt-5.2-codex")).toEqual({
        provider: "openai",
        model: "gpt-5.2-codex",
      });

      expect(extractProviderAndModel("openai/gpt-5.3-codex")).toEqual({
        provider: "openai",
        model: "gpt-5.3-codex",
      });
    });

    it("handles all valid model formats", () => {
      expect(extractProviderAndModel("anthropic/claude-haiku-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      });

      expect(extractProviderAndModel("anthropic/claude-sonnet-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });

      expect(extractProviderAndModel("anthropic/claude-opus-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-5",
      });
    });

    it("normalizes bare Claude models before extraction", () => {
      expect(extractProviderAndModel("claude-haiku-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-haiku-4-5",
      });

      expect(extractProviderAndModel("claude-sonnet-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });

      expect(extractProviderAndModel("claude-opus-4-5")).toEqual({
        provider: "anthropic",
        model: "claude-opus-4-5",
      });
    });

    it("handles edge cases", () => {
      // Empty string
      expect(extractProviderAndModel("")).toEqual({
        provider: "anthropic",
        model: "",
      });

      // Single slash at start
      expect(extractProviderAndModel("/model")).toEqual({
        provider: "",
        model: "model",
      });

      // Slash at end
      expect(extractProviderAndModel("provider/")).toEqual({
        provider: "provider",
        model: "",
      });
    });
  });

  describe("getValidModelOrDefault", () => {
    it("returns the model if valid", () => {
      expect(getValidModelOrDefault("anthropic/claude-haiku-4-5")).toBe(
        "anthropic/claude-haiku-4-5"
      );
      expect(getValidModelOrDefault("anthropic/claude-sonnet-4-5")).toBe(
        "anthropic/claude-sonnet-4-5"
      );
      expect(getValidModelOrDefault("anthropic/claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
    });

    it("normalizes bare Claude model names to prefixed format", () => {
      expect(getValidModelOrDefault("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
      expect(getValidModelOrDefault("claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
      expect(getValidModelOrDefault("claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
    });

    it("returns default for invalid model", () => {
      expect(getValidModelOrDefault("invalid-model")).toBe(DEFAULT_MODEL);
      expect(getValidModelOrDefault("gpt-4")).toBe(DEFAULT_MODEL);
    });

    it("returns default for undefined", () => {
      expect(getValidModelOrDefault(undefined)).toBe(DEFAULT_MODEL);
    });

    it("returns default for null", () => {
      expect(getValidModelOrDefault(null)).toBe(DEFAULT_MODEL);
    });

    it("returns default for empty string", () => {
      expect(getValidModelOrDefault("")).toBe(DEFAULT_MODEL);
    });
  });

  describe("supportsReasoning", () => {
    it("returns true for Claude models with reasoning config", () => {
      expect(supportsReasoning("anthropic/claude-haiku-4-5")).toBe(true);
      expect(supportsReasoning("anthropic/claude-sonnet-4-5")).toBe(true);
      expect(supportsReasoning("anthropic/claude-opus-4-5")).toBe(true);
    });

    it("supports bare Claude model names via normalization", () => {
      expect(supportsReasoning("claude-haiku-4-5")).toBe(true);
      expect(supportsReasoning("claude-sonnet-4-5")).toBe(true);
      expect(supportsReasoning("claude-opus-4-5")).toBe(true);
    });

    it("returns true for OpenAI models with reasoning config", () => {
      expect(supportsReasoning("openai/gpt-5.2")).toBe(true);
      expect(supportsReasoning("openai/gpt-5.2-codex")).toBe(true);
      expect(supportsReasoning("openai/gpt-5.3-codex")).toBe(true);
    });

    it("returns false for invalid models", () => {
      expect(supportsReasoning("gpt-4")).toBe(false);
      expect(supportsReasoning("invalid")).toBe(false);
      expect(supportsReasoning("")).toBe(false);
    });
  });

  describe("getDefaultReasoningEffort", () => {
    it("returns max for all Claude models", () => {
      expect(getDefaultReasoningEffort("anthropic/claude-haiku-4-5")).toBe("max");
      expect(getDefaultReasoningEffort("anthropic/claude-sonnet-4-5")).toBe("max");
      expect(getDefaultReasoningEffort("anthropic/claude-opus-4-5")).toBe("max");
    });

    it("returns max for bare Claude model names via normalization", () => {
      expect(getDefaultReasoningEffort("claude-haiku-4-5")).toBe("max");
      expect(getDefaultReasoningEffort("claude-sonnet-4-5")).toBe("max");
      expect(getDefaultReasoningEffort("claude-opus-4-5")).toBe("max");
    });

    it("returns high for OpenAI codex models", () => {
      expect(getDefaultReasoningEffort("openai/gpt-5.2-codex")).toBe("high");
      expect(getDefaultReasoningEffort("openai/gpt-5.3-codex")).toBe("high");
    });

    it("returns undefined for GPT 5.2 (no default)", () => {
      expect(getDefaultReasoningEffort("openai/gpt-5.2")).toBeUndefined();
    });

    it("returns undefined for invalid models", () => {
      expect(getDefaultReasoningEffort("gpt-4")).toBeUndefined();
      expect(getDefaultReasoningEffort("invalid")).toBeUndefined();
    });
  });

  describe("getReasoningConfig", () => {
    it("returns config for Claude models", () => {
      const config = getReasoningConfig("anthropic/claude-sonnet-4-5");
      expect(config).toEqual({
        efforts: ["high", "max"],
        default: "max",
      });
    });

    it("returns config for bare Claude model names via normalization", () => {
      const config = getReasoningConfig("claude-sonnet-4-5");
      expect(config).toEqual({
        efforts: ["high", "max"],
        default: "max",
      });
    });

    it("returns config for OpenAI codex models", () => {
      const config = getReasoningConfig("openai/gpt-5.2-codex");
      expect(config).toEqual({
        efforts: ["low", "medium", "high", "xhigh"],
        default: "high",
      });
    });

    it("returns config for GPT 5.2 with none effort", () => {
      const config = getReasoningConfig("openai/gpt-5.2");
      expect(config).toEqual({
        efforts: ["none", "low", "medium", "high", "xhigh"],
        default: undefined,
      });
    });

    it("returns undefined for invalid models", () => {
      expect(getReasoningConfig("invalid")).toBeUndefined();
    });
  });

  describe("isValidReasoningEffort", () => {
    it("returns true for valid effort on Claude models", () => {
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "high")).toBe(true);
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "max")).toBe(true);
    });

    it("returns false for invalid effort on Claude models", () => {
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "low")).toBe(false);
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "medium")).toBe(false);
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "xhigh")).toBe(false);
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "none")).toBe(false);
    });

    it("accepts bare Claude model names via normalization", () => {
      expect(isValidReasoningEffort("claude-sonnet-4-5", "high")).toBe(true);
      expect(isValidReasoningEffort("claude-sonnet-4-5", "max")).toBe(true);
      expect(isValidReasoningEffort("claude-sonnet-4-5", "low")).toBe(false);
    });

    it("returns true for valid effort on OpenAI codex models", () => {
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "low")).toBe(true);
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "medium")).toBe(true);
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "high")).toBe(true);
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "xhigh")).toBe(true);
    });

    it("returns false for max on OpenAI models (Anthropic-only)", () => {
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "max")).toBe(false);
      expect(isValidReasoningEffort("openai/gpt-5.3-codex", "max")).toBe(false);
      expect(isValidReasoningEffort("openai/gpt-5.2", "max")).toBe(false);
    });

    it("returns true for none on GPT 5.2 only", () => {
      expect(isValidReasoningEffort("openai/gpt-5.2", "none")).toBe(true);
      expect(isValidReasoningEffort("openai/gpt-5.2-codex", "none")).toBe(false);
    });

    it("returns false for invalid models", () => {
      expect(isValidReasoningEffort("gpt-4", "high")).toBe(false);
      expect(isValidReasoningEffort("invalid", "max")).toBe(false);
    });

    it("returns false for empty effort", () => {
      expect(isValidReasoningEffort("anthropic/claude-sonnet-4-5", "")).toBe(false);
    });
  });

  describe("normalizeModelId", () => {
    it("adds anthropic/ prefix to bare Claude models", () => {
      expect(normalizeModelId("claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
      expect(normalizeModelId("claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
      expect(normalizeModelId("claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
    });

    it("passes through already-prefixed models unchanged", () => {
      expect(normalizeModelId("anthropic/claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
      expect(normalizeModelId("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
      expect(normalizeModelId("anthropic/claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
    });

    it("passes through OpenAI models unchanged", () => {
      expect(normalizeModelId("openai/gpt-5.2")).toBe("openai/gpt-5.2");
      expect(normalizeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
      expect(normalizeModelId("openai/gpt-5.3-codex")).toBe("openai/gpt-5.3-codex");
    });

    it("passes through unknown models without prefix", () => {
      expect(normalizeModelId("gpt-4")).toBe("gpt-4");
      expect(normalizeModelId("invalid")).toBe("invalid");
      expect(normalizeModelId("")).toBe("");
    });
  });
});
