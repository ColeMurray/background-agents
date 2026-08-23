import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);
const callbackContextSchema = z.record(z.string(), z.unknown());

const sessionCompletedJobSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("session.completed"),
  payload: z.strictObject({
    sessionId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
    source: z.string().nullable(),
    success: z.boolean(),
    error: z.string().optional(),
    context: callbackContextSchema,
  }),
});

const sessionStartedJobSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("session.started"),
  payload: z.strictObject({
    sessionId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
    context: callbackContextSchema,
  }),
});

const toolCallJobSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("tool_call"),
  payload: z.strictObject({
    sessionId: nonEmptyStringSchema,
    messageId: nonEmptyStringSchema,
    source: z.string().nullable(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    callId: z.string(),
    status: z.string().optional(),
    context: callbackContextSchema,
  }),
});

/** Versioned, unsigned jobs sent by a session host to the callback delivery worker. */
export const sessionCallbackJobSchema = z.discriminatedUnion("type", [
  sessionCompletedJobSchema,
  sessionStartedJobSchema,
  toolCallJobSchema,
]);

export type SessionCallbackJob = z.infer<typeof sessionCallbackJobSchema>;
