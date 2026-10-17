import { describe, expect, it } from "vitest";
import { toPiModel, toPiThinkingLevel } from "./runtime-contract";

describe("Pi runtime contract", () => {
  it("maps Open-Inspect OpenAI model ids to Pi's Codex provider", () => {
    expect(toPiModel("openai/gpt-6.1-sol")).toEqual({
      provider: "openai-codex",
      id: "gpt-6.1-sol",
    });
    expect(toPiModel("gpt-5.5")).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
  });

  it("refuses models outside the Codex subscription provider", () => {
    expect(() => toPiModel("anthropic/claude-sonnet-4-6")).toThrow(
      "Pi Durable requires an OpenAI model"
    );
  });

  it("preserves supported Pi thinking levels and omits absent values", () => {
    expect(toPiThinkingLevel("xhigh")).toBe("xhigh");
    expect(toPiThinkingLevel("max")).toBe("max");
    expect(toPiThinkingLevel(undefined)).toBeUndefined();
    expect(() => toPiThinkingLevel("ultra")).toThrow("Unsupported Pi thinking level");
  });
});
