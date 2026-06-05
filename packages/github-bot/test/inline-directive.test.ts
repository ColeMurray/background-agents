import { describe, it, expect } from "vitest";
import { parseInlineDirective } from "../src/inline-directive";

describe("parseInlineDirective", () => {
  it("returns empty cleanedBody and no overrides for empty input", () => {
    expect(parseInlineDirective("")).toEqual({ cleanedBody: "" });
  });

  it("ignores body with no directive tokens", () => {
    const result = parseInlineDirective("please review this PR");
    expect(result).toEqual({ cleanedBody: "please review this PR" });
  });

  it("parses model only and strips the token from the body", () => {
    const result = parseInlineDirective("please review this. model: opus");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.cleanedBody).toBe("please review this.");
  });

  it("parses model + reasoning when reasoning appears first", () => {
    const result = parseInlineDirective("reasoning: high model: sonnet-4-6 do X");
    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.reasoningEffort).toBe("high");
    expect(result.cleanedBody).toBe("do X");
  });

  it("parses model + reasoning when model appears first", () => {
    const result = parseInlineDirective("model: sonnet-4-6 reasoning: high do X");
    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.reasoningEffort).toBe("high");
    expect(result.cleanedBody).toBe("do X");
  });

  it("normalizes bare alias to canonical provider/model id", () => {
    const result = parseInlineDirective("model: opus please review");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
  });

  it("accepts fully-qualified provider/model id", () => {
    const result = parseInlineDirective("model: anthropic/claude-opus-4-7 please review");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
  });

  it("is case-insensitive on the key", () => {
    const result = parseInlineDirective("MODEL: opus REASONING: high go");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.reasoningEffort).toBe("high");
  });

  it("first occurrence wins; subsequent tokens are still stripped", () => {
    const result = parseInlineDirective("model: opus please model: sonnet-4-6 do it");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.cleanedBody).not.toContain("model:");
    expect(result.cleanedBody).toBe("please do it");
  });

  it("invalid model: token stripped, no model override applied", () => {
    const result = parseInlineDirective("model: nonsense please review this");
    expect(result.model).toBeUndefined();
    expect(result.cleanedBody).toBe("please review this");
  });

  it("invalid reasoning effort for chosen model: ignored, model still applied", () => {
    // claude-sonnet-4-5 only supports "high" and "max"
    const result = parseInlineDirective("model: sonnet-4-5 reasoning: low go");
    expect(result.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result.reasoningEffort).toBeUndefined();
    expect(result.cleanedBody).toBe("go");
  });

  it("reasoning value not in the global set is dropped entirely", () => {
    const result = parseInlineDirective("reasoning: turbo go");
    expect(result.reasoningEffort).toBeUndefined();
    // token still stripped
    expect(result.cleanedBody).toBe("go");
  });

  it("flexible whitespace after colon: model:opus", () => {
    const result = parseInlineDirective("model:opus go");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.cleanedBody).toBe("go");
  });

  it("flexible whitespace after colon: extra spaces", () => {
    const result = parseInlineDirective("model:  opus go");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.cleanedBody).toBe("go");
  });

  it("does not match URL fragment containing model:foo", () => {
    const body = "see https://example.com/model:opus for details";
    const result = parseInlineDirective(body);
    expect(result.model).toBeUndefined();
    expect(result.cleanedBody).toBe(body);
  });

  it("does not match code-span prefixed by backtick", () => {
    const body = "`model:opus` is the syntax";
    const result = parseInlineDirective(body);
    expect(result.model).toBeUndefined();
    expect(result.cleanedBody).toBe(body);
  });

  it("does not match xmodel:opus (no whitespace boundary)", () => {
    const body = "xmodel:opus please review";
    const result = parseInlineDirective(body);
    expect(result.model).toBeUndefined();
    expect(result.cleanedBody).toBe(body);
  });

  it("matches when directive is at start of string", () => {
    const result = parseInlineDirective("model: opus please review");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.cleanedBody).toBe("please review");
  });

  it("matches when directive is at end of string", () => {
    const result = parseInlineDirective("please review model: opus");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.cleanedBody).toBe("please review");
  });

  it("does not strip the bot mention", () => {
    // The handler strips the @mention before calling parseInlineDirective. This
    // test asserts the parser leaves arbitrary @-text alone.
    const result = parseInlineDirective("@bot hello");
    expect(result.cleanedBody).toBe("@bot hello");
  });

  it("preserves other text around stripped directives", () => {
    const result = parseInlineDirective("hello model: opus world reasoning: high end");
    expect(result.model).toBe("anthropic/claude-opus-4-7");
    expect(result.reasoningEffort).toBe("high");
    expect(result.cleanedBody).toBe("hello world end");
  });
});
