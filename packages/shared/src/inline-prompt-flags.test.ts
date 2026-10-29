import { describe, expect, it } from "vitest";
import { parseInlinePromptFlags } from "./inline-prompt-flags";

describe("parseInlinePromptFlags", () => {
  it("parses model and reasoning flags in either supported form", () => {
    expect(
      parseInlinePromptFlags(
        "!model openai/gpt-5.6-sol !reasoning:high investigate the failing test"
      )
    ).toEqual({
      ok: true,
      text: "investigate the failing test",
      options: { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
    });
    expect(parseInlinePromptFlags("!reasoning low !model:claude-sonnet-4-6 fix it")).toEqual({
      ok: true,
      text: "fix it",
      options: { model: "claude-sonnet-4-6", reasoningEffort: "low" },
    });
  });

  it("only treats a contiguous leading prefix as flags", () => {
    expect(parseInlinePromptFlags("fix docs mentioning !model openai/gpt-5.6-sol")).toEqual({
      ok: true,
      text: "fix docs mentioning !model openai/gpt-5.6-sol",
      options: {},
    });
    expect(parseInlinePromptFlags("!unknown !model openai/gpt-5.6-sol fix it")).toEqual({
      ok: true,
      text: "!unknown !model openai/gpt-5.6-sol fix it",
      options: {},
    });
  });

  it("rejects missing and duplicate values", () => {
    expect(parseInlinePromptFlags("!model")).toEqual({
      ok: false,
      error: "The !model flag requires a value.",
    });
    expect(parseInlinePromptFlags("!reasoning high !reasoning low fix it")).toEqual({
      ok: false,
      error: "The !reasoning flag can only be specified once.",
    });
  });
});
