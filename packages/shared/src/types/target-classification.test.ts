import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_MESSAGE_MAX_CHARS,
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
      required: ["reasoning", "confidence", "targetId", "alternatives"],
      additionalProperties: false,
      properties: {
        targetId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        confidence: { enum: ["high", "medium", "low"] },
        reasoning: { type: "string", minLength: 1 },
        alternatives: { type: "array", items: { type: "string", minLength: 1 } },
      },
    });
    expect(targetClassificationJsonSchema).not.toHaveProperty("$schema");
    expect(Object.keys(targetClassificationJsonSchema.properties ?? {})).toEqual([
      "reasoning",
      "confidence",
      "targetId",
      "alternatives",
    ]);
    expect(targetClassificationJsonSchema.required).toEqual([
      "reasoning",
      "confidence",
      "targetId",
      "alternatives",
    ]);
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

    const parsed = targetClassificationRequestSchema.parse(request);
    expect(parsed).toEqual(request);
    expect(buildTargetClassificationPrompt(parsed)).toContain(
      "## User's Message\nRoute this request."
    );
    expect(
      targetClassificationRequestSchema.safeParse({
        ...request,
        message: "x".repeat(CLASSIFIER_MESSAGE_MAX_CHARS + 1),
      }).success
    ).toBe(false);

    expect(
      targetClassificationRequestSchema.safeParse({
        ...request,
        prompt: "Caller-authored prompt",
      }).success
    ).toBe(false);
  });

  it("preserves a maximum-length user message within the prompt limit", () => {
    const message = "x".repeat(CLASSIFIER_MESSAGE_MAX_CHARS);
    const request = targetClassificationRequestSchema.parse({
      message,
      targets: [
        {
          kind: "repository",
          id: "acme/api",
          fullName: "acme/api",
          description: "Acme API",
          defaultBranch: "main",
          private: true,
        },
      ],
    });

    const prompt = buildTargetClassificationPrompt(request);

    expect(prompt.length).toBe(CLASSIFIER_PROMPT_MAX_CHARS);
    expect(prompt.endsWith(message)).toBe(true);
  });

  it("renders environment and thread context as untrusted prompt data", () => {
    const request = targetClassificationRequestSchema.parse({
      message: "Deploy the full stack workspace.",
      targets: [
        {
          kind: "environment",
          id: "env_full_stack",
          name: "full-stack",
          description: null,
          repositories: ["acme/api", "acme/web"],
        },
      ],
      context: {
        channelId: "C123",
        channelName: "engineering",
        channelDescription: "Engineering requests",
        inThread: true,
        previousMessages: ["The production deploy failed."],
      },
    });

    const prompt = buildTargetClassificationPrompt(request);

    expect(prompt).toContain("No repositories are currently available.");
    expect(prompt).toContain('**env_full_stack** ("full-stack")');
    expect(prompt).toContain("Repositories: acme/api, acme/web");
    expect(prompt).toContain("**Channel**: #engineering");
    expect(prompt).toContain("**Channel Description**: Engineering requests");
    expect(prompt).toContain("**In Thread**: Yes");
    expect(prompt).toContain("- The production deploy failed.");
  });

  it("renders minimal channel context without optional metadata", () => {
    const request = targetClassificationRequestSchema.parse({
      message: "Route this request.",
      targets: [
        {
          kind: "repository",
          id: "acme/api",
          fullName: "acme/api",
          description: "Acme API",
          defaultBranch: "main",
          private: false,
        },
      ],
      context: {
        channelId: "C123",
        inThread: false,
      },
    });

    const prompt = buildTargetClassificationPrompt(request);

    expect(prompt).toContain("**Channel**: C123");
    expect(prompt).toContain("**In Thread**: No");
    expect(prompt).not.toContain("Channel Description");
    expect(prompt).not.toContain("Previous Messages in Thread");
  });

  it("truncates catalog data before truncating the user message", () => {
    const message = "m".repeat(CLASSIFIER_MESSAGE_MAX_CHARS - 100);
    const request = targetClassificationRequestSchema.parse({
      message,
      targets: [
        {
          kind: "repository",
          id: "acme/api",
          fullName: "acme/api",
          description: "catalog ".repeat(500),
          defaultBranch: "main",
          private: true,
        },
      ],
    });

    const prompt = buildTargetClassificationPrompt(request);

    expect(prompt.length).toBeLessThanOrEqual(CLASSIFIER_PROMPT_MAX_CHARS);
    expect(prompt).toContain("[truncated]");
    expect(prompt.endsWith(message)).toBe(true);
  });

  it("truncates only between complete catalog entries", () => {
    const message = "m".repeat(CLASSIFIER_MESSAGE_MAX_CHARS - 500);
    const request = targetClassificationRequestSchema.parse({
      message,
      targets: [
        {
          kind: "repository",
          id: "group/subgroup/api",
          fullName: "group/subgroup/api",
          description: "API",
          defaultBranch: "main",
          private: true,
        },
        {
          kind: "repository",
          id: "group/subgroup/worker",
          fullName: "group/subgroup/worker",
          description: "catalog ".repeat(500),
          defaultBranch: "main",
          private: true,
        },
      ],
    });

    const prompt = buildTargetClassificationPrompt(request);

    expect(prompt).toContain("**group/subgroup/api** (group/subgroup/api)");
    expect(prompt).not.toContain("group/subgroup/worker");
    expect(prompt).toContain("\n[truncated]\n\n## User's Message");
    expect(prompt.length).toBeLessThanOrEqual(CLASSIFIER_PROMPT_MAX_CHARS);
  });

  it("stops rendering catalog entries after the prompt budget is exhausted", () => {
    const message = "m".repeat(CLASSIFIER_MESSAGE_MAX_CHARS - 100);
    const request = targetClassificationRequestSchema.parse({
      message,
      targets: [
        {
          kind: "repository",
          id: "acme/oversized",
          fullName: "acme/oversized",
          description: "catalog ".repeat(500),
          defaultBranch: "main",
          private: true,
        },
        {
          kind: "repository",
          id: "acme/later",
          fullName: "acme/later",
          description: "Later entry",
          defaultBranch: "main",
          private: true,
        },
      ],
    });
    Object.defineProperty(request.targets[1], "description", {
      get: () => {
        throw new Error("later entry should not be rendered");
      },
    });

    expect(() => buildTargetClassificationPrompt(request)).not.toThrow();
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
