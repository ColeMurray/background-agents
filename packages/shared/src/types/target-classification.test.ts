import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_PROMPT_MAX_CHARS,
  ANTHROPIC_CLASSIFICATION_MODEL_ID,
  targetClassificationRequestSchema,
  targetClassificationResponseSchema,
  classificationModelSchema,
  OPENAI_CLASSIFICATION_MODEL_ID,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
  targetClassificationDecisionSchema,
  targetClassificationJsonSchema,
  buildTargetClassificationPrompt,
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
    expect(targetClassificationJsonSchema.properties?.targetId).toMatchObject({
      description: expect.stringContaining("exactly from the catalog"),
    });
    expect(targetClassificationJsonSchema.properties?.alternatives).toMatchObject({
      description: expect.stringContaining("exactly from the catalog"),
    });
    expect(TARGET_CLASSIFIER_SYSTEM_PROMPT).toContain(
      "preserve the complete repository owner, including any"
    );
  });

  it("accepts bounded domain input and rejects raw prompt authority", () => {
    const request = {
      message: "Route this request.",
      targets: [
        {
          kind: "repository" as const,
          id: "acme/api",
          fullName: "acme/api",
          description: "Acme API",
          defaultBranch: "main",
          private: true,
        },
      ],
    };

    expect(targetClassificationRequestSchema.parse(request)).toEqual(request);
    expect(buildTargetClassificationPrompt(request)).toContain(
      "## User's Message\nRoute this request."
    );
    expect(
      targetClassificationRequestSchema.safeParse({
        ...request,
        message: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1),
      }).success
    ).toBe(false);

    expect(
      targetClassificationRequestSchema.safeParse({
        ...request,
        prompt: "Caller-authored prompt",
      }).success
    ).toBe(false);
  });

  it("returns the target classification directly", () => {
    const classification = {
      targetId: null,
      confidence: "low" as const,
      reasoning: "No target is clear.",
      alternatives: [],
    };
    expect(targetClassificationResponseSchema.parse(classification)).toEqual(classification);
    expect(targetClassificationResponseSchema.safeParse({ decision: classification }).success).toBe(
      false
    );
  });
});
