import { z } from "zod";

export const slackInteractionPayloadSchema = z.object({
  type: z.string(),
  action_id: z.string().optional(),
  value: z.string().optional(),
  trigger_id: z.string().optional(),
  actions: z
    .array(
      z.object({
        action_id: z.string(),
        selected_option: z.object({ value: z.string() }).optional(),
        value: z.string().optional(),
      })
    )
    .optional(),
  channel: z.object({ id: z.string() }).optional(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional() }).optional(),
  user: z.object({ id: z.string() }).optional(),
  view: z
    .object({
      callback_id: z.string().optional(),
      private_metadata: z.string().optional(),
      state: z
        .object({
          values: z
            .record(
              z.string(),
              z.record(
                z.string(),
                z.object({ type: z.string().optional(), value: z.string().optional() })
              )
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SlackInteractionPayload = z.infer<typeof slackInteractionPayloadSchema>;
