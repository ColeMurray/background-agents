import {
  addReaction,
  escapeMrkdwnText,
  getChannelInfo,
  getThreadMessages,
  postMessage,
  resolveUserNames,
  updateMessage,
  type CallbackContext,
} from "@open-inspect/shared";
import { createClassifier } from "../classifier";
import { loadTargetCatalog } from "../classifier/catalog";
import { stripMentions } from "../dm-utils";
import { createLogger } from "../logger";
import {
  buildWorkingMessageBlocks,
  scheduleStartingStatus,
  type BackgroundTaskScheduler,
} from "../messages/blocks";
import { formatChannelContext, formatInterimThreadContext } from "../messages/context";
import { storePendingRequest } from "../pending-requests/pending-request-store";
import { sendPrompt } from "../sessions/control-plane-client";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import {
  advanceLastPromptTs,
  clearThreadSession,
  lookupThreadSession,
} from "../sessions/thread-session-store";
import { buildTargetClarificationBlocks } from "../target-clarification";
import { targetLabel } from "../targets";
import type { Env } from "../types";

const log = createLogger("handler");
const THREAD_HISTORY_MESSAGE_LIMIT = 10;

interface ThreadHistoryOptions {
  /** ts of the message currently being handled, excluded from the history. */
  excludeTs: string;
  /** Only include messages posted strictly after this Slack ts. */
  sinceTs?: string;
  includeBotMessages: boolean;
}

/**
 * Collect the last THREAD_HISTORY_MESSAGE_LIMIT relevant thread messages as
 * "[name]: text" lines. getThreadMessages paginates the full window, so the
 * newest messages survive the cap even in long threads. Returns [] when the
 * window holds no relevant messages and undefined when Slack could not be
 * queried — callers use the distinction to decide whether the window was
 * actually considered.
 */
async function fetchThreadHistory(
  env: Env,
  channel: string,
  threadTs: string,
  options: ThreadHistoryOptions
): Promise<string[] | undefined> {
  const { excludeTs, sinceTs, includeBotMessages } = options;
  try {
    const threadResult = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs, sinceTs);
    if (!threadResult.ok || !threadResult.messages) return undefined;
    const relevant = threadResult.messages
      .filter((m) => {
        if (m.ts === excludeTs) return false;
        if (!includeBotMessages && m.bot_id) return false;
        // conversations.replies can still return the parent message when
        // `oldest` is set, so re-check the boundary here.
        if (sinceTs && parseFloat(m.ts) <= parseFloat(sinceTs)) return false;
        return true;
      })
      .slice(-THREAD_HISTORY_MESSAGE_LIMIT);
    if (relevant.length === 0) return [];
    const uniqueUserIds = [...new Set(relevant.map((m) => m.user).filter(Boolean))] as string[];
    const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
    return relevant.map((m) => {
      if (m.bot_id) return `[Bot]: ${m.text}`;
      const name = m.user ? userNames.get(m.user) || m.user : "Unknown";
      return `[${name}]: ${m.text}`;
    });
  } catch {
    // Thread context is best effort.
    return undefined;
  }
}

interface IncomingMessageParams {
  text: string;
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  channelName?: string;
  channelDescription?: string;
  env: Env;
  traceId?: string;
  scheduleBackground: BackgroundTaskScheduler;
}

async function handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
  const {
    text: messageText,
    user,
    channel,
    ts,
    threadTs,
    channelName,
    channelDescription,
    env,
    traceId,
    scheduleBackground,
  } = params;
  if (!messageText) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Hi! Please include a message with your request.",
      { thread_ts: threadTs || ts }
    );
    return;
  }

  if (threadTs) {
    const existingSession = await lookupThreadSession(env, channel, threadTs);
    if (existingSession) {
      const callbackContext: CallbackContext = {
        source: "slack",
        channel,
        threadTs,
        repoFullName: existingSession.repoFullName,
        model: existingSession.model,
        reasoningEffort: existingSession.reasoningEffort,
        reactionMessageTs: ts,
      };
      const channelContext = channelName
        ? formatChannelContext(channelName, channelDescription)
        : "";
      // The session already has its own turns, so only forward the human
      // discussion that happened in the thread since the last prompt.
      const interimMessages = existingSession.lastPromptTs
        ? await fetchThreadHistory(env, channel, threadTs, {
            excludeTs: ts,
            sinceTs: existingSession.lastPromptTs,
            includeBotMessages: false,
          })
        : undefined;
      const interimContext = interimMessages ? formatInterimThreadContext(interimMessages) : "";
      const promptResult = await sendPrompt(
        env,
        existingSession.sessionId,
        channelContext + interimContext + messageText,
        `slack:${user}`,
        callbackContext,
        traceId
      );
      if (promptResult.ok) {
        // Only advance the checkpoint past messages we know were considered.
        // When the interim fetch failed, keeping the old watermark lets the
        // next follow-up retry the window; at worst it re-includes this
        // message's text as interim context.
        const interimFetchFailed = Boolean(existingSession.lastPromptTs) && !interimMessages;
        if (!interimFetchFailed) {
          await advanceLastPromptTs(env, channel, threadTs, ts);
        }
        const reactionResult = await addReaction(env.SLACK_BOT_TOKEN, channel, ts, "eyes");
        if (!reactionResult.ok && reactionResult.error !== "already_reacted") {
          log.warn("slack.reaction.add", {
            trace_id: traceId,
            channel,
            message_ts: ts,
            reaction: "eyes",
            slack_error: reactionResult.error,
          });
        }
        return;
      }
      if (promptResult.reason === "transient") {
        await postMessage(
          env.SLACK_BOT_TOKEN,
          channel,
          "Sorry, I couldn't send your follow-up. Please try again.",
          { thread_ts: threadTs }
        );
        return;
      }
      log.warn("thread_session.stale", {
        trace_id: traceId,
        session_id: existingSession.sessionId,
        channel,
        thread_ts: threadTs,
      });
      await clearThreadSession(env, channel, threadTs);
    }
  }

  const previousMessages = threadTs
    ? await fetchThreadHistory(env, channel, threadTs, { excludeTs: ts, includeBotMessages: true })
    : undefined;

  const result = await createClassifier(env).classify(
    messageText,
    { channelId: channel, channelName, channelDescription, threadTs, previousMessages },
    traceId
  );
  if (result.needsClarification || !result.target) {
    const catalog = await loadTargetCatalog(env, traceId);
    if (catalog.repos.length === 0 && catalog.environments.length === 0) {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, no repositories or environments are currently available. Please check that the GitHub App is installed and configured.",
        { thread_ts: threadTs || ts }
      );
      return;
    }
    await storePendingRequest(env, channel, threadTs || ts, {
      message: messageText,
      userId: user,
      previousMessages,
      channelName,
      channelDescription,
    });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      `I couldn't determine which ${catalog.environments.length > 0 ? "repository or environment" : "repository"} you're referring to. ${result.reasoning}`,
      {
        thread_ts: threadTs || ts,
        blocks: buildTargetClarificationBlocks(result.reasoning, result.alternatives, catalog),
      }
    );
    return;
  }

  const label = escapeMrkdwnText(targetLabel(result.target));
  const threadKey = threadTs || ts;
  const ackResult = await postMessage(env.SLACK_BOT_TOKEN, channel, `Working on *${label}*...`, {
    thread_ts: threadKey,
    blocks: buildWorkingMessageBlocks(label, { reasoning: result.reasoning }),
  });
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  const sessionResult = await startSessionAndSendPrompt(env, {
    target: result.target,
    channel,
    threadTs: threadKey,
    messageText,
    userId: user,
    messageTs: ts,
    previousMessages,
    channelName,
    channelDescription,
    traceId,
  });
  if (!sessionResult) return;
  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${label}*...`, {
      blocks: buildWorkingMessageBlocks(label, {
        reasoning: result.reasoning,
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}

export async function handleAppMention(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  const messageText = stripMentions(event.text);
  const threadKey = event.thread_ts || event.ts;
  if (messageText)
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  let channelName: string | undefined;
  let channelDescription: string | undefined;
  if (messageText) {
    try {
      const channelInfo = await getChannelInfo(env.SLACK_BOT_TOKEN, event.channel);
      if (channelInfo.ok && channelInfo.channel) {
        channelName = channelInfo.channel.name;
        channelDescription = channelInfo.channel.topic?.value || channelInfo.channel.purpose?.value;
      }
    } catch {
      // Channel context is best effort.
    }
  }
  await handleIncomingMessage({
    text: messageText,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    channelName,
    channelDescription,
    env,
    traceId,
    scheduleBackground,
  });
}

export async function handleDirectMessage(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    channel_type?: string;
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  log.info("slack.dm.received", { trace_id: traceId, user: event.user, channel: event.channel });
  const messageText = stripMentions(event.text);
  const threadKey = event.thread_ts || event.ts;
  if (messageText)
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  await handleIncomingMessage({
    text: messageText,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    env,
    traceId,
    scheduleBackground,
  });
}
