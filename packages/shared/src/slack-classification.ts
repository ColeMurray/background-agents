import { z } from "zod";

export const OPENAI_SLACK_CLASSIFICATION_MODEL = "openai/gpt-5.6-luna";
export const NO_REPOSITORY_TARGET_VALUE = "__no_repository__";
// Accommodate complete catalogs of thousands of described targets. JSON
// escaping still fits below the signed service request's byte cap.
export const SLACK_CLASSIFICATION_MAX_PROMPT_LENGTH = 1024 * 1024;
export const SLACK_OAUTH_CLASSIFICATION_TIMEOUT_MS = 30_000;
// Reserve caller time for signing, admission, transit, and response delivery.
export const SLACK_OAUTH_CLASSIFICATION_SERVER_TIMEOUT_MS =
  SLACK_OAUTH_CLASSIFICATION_TIMEOUT_MS - 5_000;

export const slackClassificationRequestSchema = z
  .object({
    prompt: z.string().min(1).max(SLACK_CLASSIFICATION_MAX_PROMPT_LENGTH),
  })
  .strict();

const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export const SLACK_CLASSIFICATION_TOOL = {
  name: "classify_target",
  description:
    "Classify which repository, environment, or repository-less sandbox a Slack message needs. " +
    "Use targetId as null when uncertain.",
  input_schema: {
    type: "object" as const,
    properties: {
      targetId: {
        type: ["string", "null"],
        description: `A repository "owner/name", an environment id ("env_…"), or "${NO_REPOSITORY_TARGET_VALUE}". Use null when unclear.`,
      },
      confidence: {
        type: "string",
        enum: CONFIDENCE_LEVELS,
      },
      reasoning: {
        type: "string",
        description: "Brief explanation of classification decision.",
      },
      alternatives: {
        type: "array",
        items: { type: "string" },
        description: `Other reasonable repository fullNames, environment ids, or "${NO_REPOSITORY_TARGET_VALUE}", especially whenever clarification may be required.`,
      },
    },
    required: ["targetId", "confidence", "reasoning", "alternatives"],
    additionalProperties: false,
  },
};

export const slackClassificationDecisionSchema = z.object({
  targetId: z
    .union([z.string(), z.null()])
    .transform((value) => (typeof value === "string" && value.trim() ? value.trim() : null)),
  confidence: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.enum(CONFIDENCE_LEVELS)),
  reasoning: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1)),
  alternatives: z
    .array(
      z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1))
    )
    .transform((values) => [...new Set(values)]),
});
