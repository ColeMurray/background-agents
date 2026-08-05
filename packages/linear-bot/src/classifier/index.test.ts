import { describe, expect, it } from "vitest";
import { anthropicMessagesResponseSchema, classifyToolInputSchema } from "./index";

describe("anthropicMessagesResponseSchema", () => {
  it("parses a response with the consumed tool block fields", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_repository",
          input: {
            repoId: "org/repo",
            confidence: "high",
            reasoning: "The issue names the repo.",
            alternatives: [],
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without content", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({ id: "msg_1" });

    expect(parsed.success).toBe(false);
  });
});

describe("classifyToolInputSchema", () => {
  it("parses a valid classification tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "medium",
      reasoning: "The labels match this repository.",
      alternatives: ["org/other"],
    });

    expect(parsed.success).toBe(true);
  });

  it("parses a null repoId for low-confidence classifications", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: null,
      confidence: "low",
      reasoning: "No repository was a clear match.",
      alternatives: ["org/api", "org/web"],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects malformed or partial tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "certain",
      reasoning: "Invalid confidence value.",
    });

    expect(parsed.success).toBe(false);
  });
});
