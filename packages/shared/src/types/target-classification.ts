import { z } from "zod";

export const CLASSIFY_TARGET_TOOL_NAME = "classify_target";
export const CLASSIFIER_PROMPT_MAX_CHARS = 128_000;

export const ANTHROPIC_CLASSIFICATION_MODEL_ID = "anthropic/claude-haiku-4-5";
export const OPENAI_CLASSIFICATION_MODEL_ID = "openai/gpt-5.6-luna";

export const classificationModelSchema = z.enum([
  ANTHROPIC_CLASSIFICATION_MODEL_ID,
  OPENAI_CLASSIFICATION_MODEL_ID,
]);

export type ClassificationModel = z.infer<typeof classificationModelSchema>;

const nonEmptyTrimmedStringSchema = z.string().trim().min(1, "Must not be empty");

export const targetClassificationDecisionSchema = z
  .object({
    targetId: nonEmptyTrimmedStringSchema
      .nullable()
      .describe(
        'A repository "owner/name" or an environment id ("env_…") if confident, otherwise null.'
      ),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: nonEmptyTrimmedStringSchema.describe(
      "Brief explanation of the classification decision."
    ),
    alternatives: z
      .array(nonEmptyTrimmedStringSchema)
      .describe("Alternative target ids when confidence is not high."),
  })
  .strict();

export type TargetClassificationDecision = z.infer<typeof targetClassificationDecisionSchema>;

export const openAIClassifierInferenceRequestSchema = z
  .object({
    systemPrompt: z.string().trim().min(1).max(CLASSIFIER_PROMPT_MAX_CHARS),
    prompt: z.string().min(1).max(CLASSIFIER_PROMPT_MAX_CHARS),
  })
  .strict();

export type OpenAIClassifierInferenceRequest = z.infer<
  typeof openAIClassifierInferenceRequestSchema
>;

export const classifierInferenceResponseSchema = z
  .object({ decision: targetClassificationDecisionSchema })
  .strict();

export type ClassifierInferenceResponse = z.infer<typeof classifierInferenceResponseSchema>;

const { $schema: _metaSchema, ...generatedDecisionJsonSchema } = z.toJSONSchema(
  targetClassificationDecisionSchema
);

/** Provider-neutral schema used for forced classifier tool calls. */
export const targetClassificationJsonSchema: typeof generatedDecisionJsonSchema & {
  type: "object";
} = {
  ...generatedDecisionJsonSchema,
  type: "object",
};
