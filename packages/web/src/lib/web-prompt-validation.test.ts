import { describe, expect, it } from "vitest";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";
import { getWebPromptLengthError } from "./web-prompt-validation";

describe("getWebPromptLengthError", () => {
  it("accepts the maximum and rejects content above it with a visible message", () => {
    expect(getWebPromptLengthError("x".repeat(MAX_WEB_PROMPT_CHARS))).toBeNull();
    expect(getWebPromptLengthError("x".repeat(MAX_WEB_PROMPT_CHARS + 1))).toBe(
      `Prompt must be ${MAX_WEB_PROMPT_CHARS.toLocaleString()} characters or fewer`
    );
  });
});
