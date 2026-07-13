import { publishAppHome } from "../app-home";
import { handleChannelTrigger } from "../channel-trigger";
import { isDmDispatchable } from "../dm-utils";
import type { BackgroundTaskScheduler } from "../messages/blocks";
import type { Env } from "../types";
import { handleAppMention, handleDirectMessage } from "./message-handler";

export interface SlackEventPayload {
  type: string;
  event?: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    tab?: string;
    channel_type?: string;
    subtype?: string;
    attachments?: Array<{
      text?: string;
      pretext?: string;
      author_name?: string;
      from_url?: string;
      channel_name?: string;
      footer?: string;
    }>;
  };
}

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
