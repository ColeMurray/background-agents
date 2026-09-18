import {
  classifyThreadSpeaker,
  getThreadMessages,
  resolveUserNames,
  selectThreadWindow,
  type SlackThreadMessage,
} from "@open-inspect/shared/slack";
import { slackFileAnnotations, toImageAttachments, type SlackImageAttachment } from "./attachments";
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
  const seen = new Set<string>();
  return toImageAttachments(
    messages.flatMap((message) => message.files ?? []),
    traceId
  ).filter((attachment) => {
    const identity = attachment.id ? `id:${attachment.id}` : `url:${attachment.downloadUrl}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
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

    const speakers = relevant.map((message) => classifyThreadSpeaker(message));
    const uniqueUserIds = [
      ...new Set(speakers.flatMap((speaker) => (speaker.kind === "user" ? [speaker.id] : []))),
    ];
    const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
    const messages = relevant.map((message, index) => {
      const speaker = speakers[index]!;
      const name =
        speaker.kind === "app"
          ? "Bot"
          : speaker.kind === "user"
            ? (userNames.get(speaker.id) ?? speaker.id)
            : "Unknown";
      const body = message.text || "(no text)";
      const fileContext = slackFileAnnotations(message.files, "interactive");
      return `[${name} at Slack ts ${message.ts}]: ${[body, ...fileContext].join("\n")}`;
    });
    return { messages, images: collectContextImages(relevant, traceId) };
  } catch {
    // Thread context is best effort.
    return undefined;
  }
}
