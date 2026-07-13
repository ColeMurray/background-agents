import { z } from "zod";
import { publishAppHome } from "../app-home";
import { handleChannelTrigger } from "../channel-trigger";
import { isDmDispatchable } from "../dm-utils";
import type { BackgroundTaskScheduler } from "../messages/blocks";
import type { Env } from "../types";
import { handleAppMention, handleDirectMessage } from "./message-handler";

export const slackEventPayloadSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
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
      attachments: z
        .array(
          z.object({
            text: z.string().optional(),
            pretext: z.string().optional(),
            author_name: z.string().optional(),
            from_url: z.string().optional(),
            channel_name: z.string().optional(),
            footer: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

export type SlackEventPayload = z.infer<typeof slackEventPayloadSchema>;

export async function handleSlackEvent(
  payload: SlackEventPayload,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  if (payload.type !== "event_callback" || !payload.event) return;
  const event = payload.event;
  if (event.bot_id) return;
  if (event.type === "app_home_opened" && event.tab === "home" && event.user) {
    await publishAppHome(env, event.user);
    return;
  }
  if (isDmDispatchable(event)) {
    await handleDirectMessage(
      {
        type: event.type,
        text: event.text!,
        user: event.user!,
        channel: event.channel!,
        ts: event.ts!,
        thread_ts: event.thread_ts,
        channel_type: event.channel_type,
      },
      env,
      traceId,
      scheduleBackground
    );
    return;
  }
  if (event.type === "app_mention" && event.text && event.channel && event.ts) {
    await handleAppMention(event as Required<typeof event>, env, traceId, scheduleBackground);
    return;
  }
  if (event.type === "message") await handleChannelTrigger(event, env, traceId);
}
