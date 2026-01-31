import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL,
  isValidModel,
  extractProviderAndModel,
  getValidModelOrDefault,
} from "./models";

describe("model utilities", () => {
  describe("DEFAULT_MODEL", () => {
    it("is a valid model", () => {
      expect(isValidModel(DEFAULT_MODEL)).toBe(true);
    });
  });

  describe("isValidModel", () => {
    it("returns true for valid models", () => {
      expect(isValidModel("claude-haiku-4-5")).toBe(true);
      expect(isValidModel("claude-sonnet-4-5")).toBe(true);
      expect(isValidModel("claude-opus-4-5")).toBe(true);
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

    it("handles all valid model formats", () => {
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
      expect(getValidModelOrDefault("claude-haiku-4-5")).toBe("claude-haiku-4-5");
      expect(getValidModelOrDefault("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
      expect(getValidModelOrDefault("claude-opus-4-5")).toBe("claude-opus-4-5");
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
});
