import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_PROMPT_MAX_CHARS,
  ANTHROPIC_CLASSIFICATION_MODEL_ID,
  classifierInferenceRequestSchema,
  classifierInferenceResponseSchema,
  classificationModelSchema,
  OPENAI_CLASSIFICATION_MODEL_ID,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
} from "./target-classification";

describe("target classification contracts", () => {
  it("allows only the supported classifier models", () => {
    expect(classificationModelSchema.parse(ANTHROPIC_CLASSIFICATION_MODEL_ID)).toBe(
      ANTHROPIC_CLASSIFICATION_MODEL_ID
    );
    expect(classificationModelSchema.parse(OPENAI_CLASSIFICATION_MODEL_ID)).toBe(
      OPENAI_CLASSIFICATION_MODEL_ID
    );
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

  it("rejects whitespace-only decision strings", () => {
    const decision = {
      targetId: "   ",
      confidence: "high",
      reasoning: "A reason.",
      alternatives: ["   "],
    };

    expect(targetClassificationDecisionSchema.safeParse(decision).success).toBe(false);
    expect(
      targetClassificationDecisionSchema.safeParse({ ...decision, targetId: null }).success
    ).toBe(false);
  });

  it("derives a strict provider tool schema from the decision contract", () => {
    expect(targetClassificationJsonSchema).toMatchObject({
      type: "object",
      required: ["targetId", "confidence", "reasoning", "alternatives"],
      additionalProperties: false,
      properties: {
        targetId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        confidence: { enum: ["high", "medium", "low"] },
        reasoning: { type: "string", minLength: 1 },
        alternatives: { type: "array", items: { type: "string", minLength: 1 } },
      },
    });
    expect(targetClassificationJsonSchema).not.toHaveProperty("$schema");
  });

  it("bounds inference prompts and wraps decisions at the service boundary", () => {
    expect(
      classifierInferenceRequestSchema.safeParse({
        model: "openai/gpt-5.6-luna",
        systemPrompt: "Classify the target.",
        prompt: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1),
      }).success
    ).toBe(false);

    expect(
      classifierInferenceRequestSchema.safeParse({
        model: "openai/gpt-5.6-luna",
        systemPrompt: "   ",
        prompt: "Route this request.",
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
