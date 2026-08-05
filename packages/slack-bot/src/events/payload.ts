/**
 * The canonical model of the Slack Events API envelope this bot consumes.
 *
 * The schema is the single source of truth: the `/events` route validates every
 * inbound payload with it and `SlackEventPayload` — the type the dispatcher and
 * every downstream handler speak — is inferred from it. A field added here
 * therefore reaches the trust boundary and the handlers together; it can never
 * be declared on the type but silently stripped by the parser, or vice versa.
 *
 * File and attachment shapes are reused from `@open-inspect/shared/slack`,
 * where the same schemas back `SlackMessageFile` / `SlackMessageAttachment`.
 *
 * It lives beside the dispatcher rather than inside it so that the route can
 * import the schema without importing the whole handler graph.
 */

import { slackMessageAttachmentSchema, slackMessageFileSchema } from "@open-inspect/shared/slack";
import { z } from "zod";

export const slackEventPayloadSchema = z.object({
  type: z.string(),
  /** Only present on the `url_verification` handshake. */
  challenge: z.string().optional(),
  /** Present on `event_callback` deliveries; used for Slack retry dedupe. */
  event_id: z.string().optional(),
  event: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      user: z.string().optional(),
      channel: z.string().optional(),
      ts: z.string().optional(),
      thread_ts: z.string().optional(),
      bot_id: z.string().optional(),
      tab: z.string().optional(),
      channel_type: z.string().optional(),
      subtype: z.string().optional(),
      files: z.array(slackMessageFileSchema).optional(),
      attachments: z.array(slackMessageAttachmentSchema).optional(),
    })
    .optional(),
});

export type SlackEventPayload = z.infer<typeof slackEventPayloadSchema>;
