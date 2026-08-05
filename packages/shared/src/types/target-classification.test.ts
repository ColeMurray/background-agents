import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_PROMPT_MAX_CHARS,
  classifierInferenceRequestSchema,
  classifierInferenceResponseSchema,
  classificationModelSchema,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
} from "./target-classification";

describe("target classification contracts", () => {
  it("allows only the supported classifier models", () => {
    expect(classificationModelSchema.parse("anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5"
    );
    expect(classificationModelSchema.parse("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(classificationModelSchema.safeParse("openai/gpt-5.6-sol").success).toBe(false);
  });

  it("validates a strict provider-neutral decision", () => {
    const decision = {
      targetId: "acme/web",
      confidence: "high",
      reasoning: "The message names the web app.",
      alternatives: [],
    };

    expect(targetClassificationDecisionSchema.parse(decision)).toEqual(decision);
    expect(
      targetClassificationDecisionSchema.safeParse({ ...decision, unexpected: true }).success
    ).toBe(false);
  });

  it("derives a strict provider tool schema from the decision contract", () => {
    expect(targetClassificationJsonSchema).toMatchObject({
      type: "object",
      required: ["targetId", "confidence", "reasoning", "alternatives"],
      additionalProperties: false,
      properties: {
        confidence: { enum: ["high", "medium", "low"] },
      },
    });
    expect(targetClassificationJsonSchema).not.toHaveProperty("$schema");
    expect(JSON.stringify(targetClassificationJsonSchema)).not.toContain("minLength");
  });

  it("bounds inference prompts and wraps decisions at the service boundary", () => {
    expect(
      classifierInferenceRequestSchema.safeParse({
        model: "openai/gpt-5.6-luna",
        prompt: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1),
      }).success
    ).toBe(false);

    expect(
      classifierInferenceResponseSchema.parse({
        decision: {
          targetId: null,
          confidence: "low",
          reasoning: "No target is clear.",
          alternatives: [],
        },
      })
    ).toEqual({
      decision: {
        targetId: null,
        confidence: "low",
        reasoning: "No target is clear.",
        alternatives: [],
      },
    });
  });
});
