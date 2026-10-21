import { describe, expect, it } from "vitest";
import { piModelAcceptsImages } from "./model-image-support";

describe("piModelAcceptsImages", () => {
  it("accepts a codex model that takes images", () => {
    expect(piModelAcceptsImages("openai/gpt-5.6-sol")).toBe(true);
    expect(piModelAcceptsImages("openai/gpt-6.1-sol")).toBe(true);
  });

  it("refuses a codex model that takes text only", () => {
    expect(piModelAcceptsImages("openai/gpt-5.3-codex-spark")).toBe(false);
  });

  it("refuses a model the codex catalog does not hold", () => {
    expect(piModelAcceptsImages("openai/gpt-5.4")).toBe(false);
  });

  it("refuses a model another provider owns", () => {
    expect(piModelAcceptsImages("anthropic/claude-fable-5-1")).toBe(false);
  });
});
