import {
  getThreadMessages,
  selectThreadWindow,
  type SlackThreadMessage,
} from "@open-inspect/shared/slack";
import { toImageAttachments, type SlackImageAttachment } from "./attachments";
import { collectForwardedMessages } from "./forwarded-messages";
import { buildThreadContextRecords, renderThreadContext } from "./thread-context";
import type { Env } from "./types";

const THREAD_HISTORY_MESSAGE_LIMIT = 10;

export interface InteractiveThreadContext {
  messages: string[];
  images: SlackImageAttachment[];
}

export interface InteractiveThreadContextOptions {
  /** The current trigger. Only messages strictly before it are eligible. */
  beforeTs: string;
  /** Only include messages posted strictly after this Slack ts. */
  sinceTs?: string;
  includeBotMessages: boolean;
}

function collectContextImages(messages: SlackThreadMessage[], traceId?: string) {
  return toImageAttachments(
    [...messages].reverse().flatMap((message) => {
      const forwarded = collectForwardedMessages(message.attachments);
      return [...(message.files ?? []), ...forwarded.files];
    }),
    traceId
  );
}

/** Fetch bounded, causal context for interactive mentions and DMs. */
export async function fetchInteractiveThreadContext(
  env: Env,
  channel: string,
  threadTs: string,
  options: InteractiveThreadContextOptions,
  traceId?: string
): Promise<InteractiveThreadContext | undefined> {
  const { beforeTs, sinceTs, includeBotMessages } = options;
  try {
    const threadResult = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs, sinceTs);
    if (!threadResult.ok) return undefined;
    const relevant = selectThreadWindow(threadResult.messages, {
      excludeTs: beforeTs,
      beforeTs,
      sinceTs,
      limit: THREAD_HISTORY_MESSAGE_LIMIT,
      excludeBots: !includeBotMessages,
    });
    if (relevant.length === 0) return { messages: [], images: [] };

    const records = await buildThreadContextRecords(env, relevant, "interactive", traceId);
    return {
      messages: [renderThreadContext(records)],
      images: collectContextImages(relevant, traceId),
    };
  } catch {
    // Thread context is best effort.
    return undefined;
  }
}
