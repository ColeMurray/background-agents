/**
 * Solo threads: mention-free follow-ups in a channel thread that one person
 * has to themselves.
 *
 * A thread becomes solo for a person when their mention of the bot launches a
 * session in it while they and bots are its only posters, and the session's
 * acknowledgement tells them so. Their later untagged replies then continue
 * that session. Once another person posts, the thread is blocked for good: the
 * bot says so in the thread, and instructions need a mention again.
 *
 * Workers KV reads can be stale and Slack events can be missed, so the stored
 * record alone cannot prove nobody else has posted. Every untagged reply
 * therefore re-reads the thread, and takes the reply only when the history is
 * complete and shows no other person.
 */

import {
  getThreadMessages,
  postMessage,
  type SlackMessageAttachment,
  type SlackMessageFile,
  type SlackThreadMessage,
} from "@open-inspect/shared/slack";
import { isDirectMessageChannel, mentionsUser, startsWithUserMention } from "./dm-utils";
import { createLogger } from "./logger";
import { formatSoloThreadEndedNotice } from "./messages/blocks";
import { storeSoloThread, type SoloThreadRecord } from "./sessions/solo-thread-store";
import type { Env } from "./types";

const log = createLogger("solo-thread");

/** Slackbot posts reminders and notices under this user id, without a `bot_id`. */
const SLACKBOT_USER_ID = "USLACKBOT";

/** What a thread's history says about whether `userId` has it to themselves. */
export type ThreadParticipation = "solo" | "shared" | "unknown";

type ThreadHistory =
  { ok: false } | { ok: true; messages: readonly SlackThreadMessage[]; truncated: boolean };

/** Judge a thread read; only a complete history with no other person is "solo". */
export function judgeThreadParticipation(
  history: ThreadHistory,
  threadTs: string,
  userId: string
): ThreadParticipation {
  if (!history.ok) return "unknown";
  const postedByAnotherPerson = (message: SlackThreadMessage) =>
    message.user !== undefined &&
    message.bot_id === undefined &&
    message.user !== SLACKBOT_USER_ID &&
    message.user !== userId;
  if (history.messages.some(postedByAnotherPerson)) return "shared";
  // Without the root or the pages past the cap, a poster in the unread part would go unseen.
  if (history.truncated || !history.messages.some((message) => message.ts === threadTs)) {
    return "unknown";
  }
  // A message that names neither a person nor a bot could be anyone's.
  if (
    history.messages.some((message) => message.user === undefined && message.bot_id === undefined)
  ) {
    return "unknown";
  }
  return "solo";
}

/** Read the whole thread from Slack and judge whether `userId` has it to themselves. */
export async function readThreadParticipation(
  env: Env,
  channel: string,
  threadTs: string,
  userId: string,
  traceId?: string
): Promise<ThreadParticipation> {
  const history = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs);
  const participation = judgeThreadParticipation(history, threadTs, userId);
  if (participation === "unknown") {
    log.warn("solo_thread.history_incomplete", {
      trace_id: traceId,
      channel,
      thread_ts: threadTs,
      slack_error: history.ok ? undefined : history.error,
      truncated: history.ok ? history.truncated : undefined,
    });
  }
  return participation;
}

/**
 * Arm a channel thread for the person whose mention just launched its session,
 * when the thread's history shows they are its only person. Even a thread the
 * mention started is read: another person can reply while the session starts,
 * and their reply found no record to block. Best effort: any failure leaves the
 * thread unarmed. Returns whether it armed, and the caller shows the solo hint
 * exactly then, so no thread is armed without its owner being told.
 */
export async function armSoloThread(
  env: Env,
  launch: { channel: string; threadTs: string; ownerUserId: string },
  traceId?: string
): Promise<boolean> {
  const { channel, threadTs, ownerUserId } = launch;
  if (isDirectMessageChannel(channel)) return false;
  try {
    if ((await readThreadParticipation(env, channel, threadTs, ownerUserId, traceId)) !== "solo") {
      return false;
    }
    await storeSoloThread(env, channel, threadTs, { kind: "owned", ownerUserId });
    log.info("solo_thread.armed", { trace_id: traceId, channel, thread_ts: threadTs });
    return true;
  } catch (error) {
    log.error("solo_thread.arm_failed", {
      trace_id: traceId,
      channel,
      thread_ts: threadTs,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return false;
  }
}

/**
 * End a solo thread: store the block, then tell everyone in the thread that
 * instructions need a mention again. Throws when the store fails, before
 * anything is posted, so the notice never announces a block that was not kept.
 */
export async function blockSoloThread(
  env: Env,
  thread: { channel: string; threadTs: string; botUserId: string },
  reason: SoloThreadBlockReason,
  traceId?: string
): Promise<void> {
  const { channel, threadTs, botUserId } = thread;
  await storeSoloThread(env, channel, threadTs, { kind: "blocked" });
  log.info("solo_thread.blocked", { trace_id: traceId, channel, thread_ts: threadTs, reason });
  const notice = await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    formatSoloThreadEndedNotice(botUserId),
    { thread_ts: threadTs }
  );
  if (!notice.ok) {
    log.warn("solo_thread.notice_failed", {
      trace_id: traceId,
      channel,
      thread_ts: threadTs,
      slack_error: notice.error,
    });
  }
}

/** A person's untagged reply in a channel thread, as the solo-thread checks see it. */
export interface SoloThreadReply {
  user: string;
  channel: string;
  ts: string;
  threadTs: string;
  text: string;
  files?: SlackMessageFile[];
  attachments?: SlackMessageAttachment[];
  /** Also sent to the channel: it still shows who posted, but is never an instruction. */
  sentToChannel: boolean;
}

/**
 * The `message` events that could be a person's untagged reply in a channel
 * thread: the subtypes the mention and automation paths admit, plus "also send
 * to channel" broadcasts, which can reveal another person. Edits and deletions
 * never count.
 */
export function toSoloThreadReply(event: {
  type: string;
  subtype?: string;
  channel_type?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  files?: SlackMessageFile[];
  attachments?: SlackMessageAttachment[];
}): SoloThreadReply | null {
  const { user, channel, ts, thread_ts: threadTs, text = "", files, attachments } = event;
  if (event.type !== "message") return null;
  const sentToChannel = event.subtype === "thread_broadcast";
  if (event.subtype && event.subtype !== "file_share" && !sentToChannel) return null;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return null;
  if (event.bot_id || !user || user === SLACKBOT_USER_ID) return null;
  if (!channel || !ts || !threadTs || threadTs === ts) return null;
  if (!text && !files?.length && !attachments?.length) return null;
  return { user, channel, ts, threadTs, text, files, attachments, sentToChannel };
}

/** Why a solo thread stopped being solo. */
export type SoloThreadBlockReason = "other_poster" | "other_poster_in_history";

/**
 * Sort an untagged reply by what is known without any Slack or control-plane
 * read: `verify` an owner's reply that may be an instruction, `block` another
 * person's reply in an owned thread, and `ignore` everything else.
 */
export function screenSoloReply(
  record: SoloThreadRecord | null,
  reply: Pick<SoloThreadReply, "user" | "text" | "sentToChannel">,
  botUserId: string
): "verify" | "ignore" | "block" {
  if (record?.kind !== "owned") return "ignore";
  if (record.ownerUserId !== reply.user) return "block";
  if (reply.sentToChannel) return "ignore";
  // A tagged reply also arrives as `app_mention`, which handles it; one that opens on a
  // teammate is meant for them.
  if (mentionsUser(reply.text, botUserId) || startsWithUserMention(reply.text)) return "ignore";
  return "verify";
}
