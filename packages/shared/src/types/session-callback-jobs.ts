import { z } from "zod";
import {
  automationCallbackContextSchema,
  linearCompletionCallbackPayloadSchema,
  linearStartCallbackSchema,
  linearToolCallCallbackPayloadSchema,
  slackCallbackContextSchema,
  SLACK_ACTIVITY_REFRESH_KIND,
} from "./session-api";

const identity = {
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  timestamp: z.number().finite(),
};
const completed = z.strictObject({
  ...identity,
  success: z.boolean(),
  error: z.string().optional(),
  context: slackCallbackContextSchema,
});
const toolCall = z.strictObject({
  sessionId: identity.sessionId,
  timestamp: identity.timestamp,
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  callId: z.string(),
  status: z.string().optional(),
  context: slackCallbackContextSchema,
});

/** Unsigned, versioned events. Event time is captured once, never refreshed on retry. */
export const sessionCallbackJobSchema = z.discriminatedUnion("type", [
  z.strictObject({ version: z.literal(1), type: z.literal("slack.completed"), payload: completed }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("linear.completed"),
    payload: linearCompletionCallbackPayloadSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("linear.started"),
    payload: linearStartCallbackSchema.omit({ signature: true }),
  }),
  z.strictObject({ version: z.literal(1), type: z.literal("slack.tool_call"), payload: toolCall }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("linear.tool_call"),
    payload: linearToolCallCallbackPayloadSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("slack.activity_refresh"),
    payload: z.strictObject({
      ...identity,
      kind: z.literal(SLACK_ACTIVITY_REFRESH_KIND),
      context: slackCallbackContextSchema,
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("automation.completed"),
    payload: completed.extend({ context: automationCallbackContextSchema }),
  }),
]);

export type SessionCallbackJob = z.infer<typeof sessionCallbackJobSchema>;
