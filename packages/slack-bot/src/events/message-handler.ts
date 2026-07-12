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
import { formatChannelContext } from "../messages/context";
import { storePendingRequest } from "../pending-requests/pending-request-store";
import { sendPrompt } from "../sessions/control-plane-client";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { clearThreadSession, lookupThreadSession } from "../sessions/thread-session-store";
import { buildTargetClarificationBlocks } from "../target-clarification";
import { targetLabel } from "../targets";
import type { Env } from "../types";

const log = createLogger("handler");

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
      const promptResult = await sendPrompt(
        env,
        existingSession.sessionId,
        channelContext + messageText,
        `slack:${user}`,
        callbackContext,
        traceId
      );
      if (promptResult.ok) {
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

  let previousMessages: string[] | undefined;
  if (threadTs) {
    try {
      const threadResult = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs, 10);
      if (threadResult.ok && threadResult.messages) {
        const filtered = threadResult.messages.filter((m) => m.ts !== ts);
        const uniqueUserIds = [...new Set(filtered.map((m) => m.user).filter(Boolean))] as string[];
        const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
        previousMessages = filtered
          .map((m) => {
            if (m.bot_id) return `[Bot]: ${m.text}`;
            const name = m.user ? userNames.get(m.user) || m.user : "Unknown";
            return `[${name}]: ${m.text}`;
          })
          .slice(-10);
      }
    } catch {
      // Thread context is best effort.
    }
  }

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
  const sessionResult = await startSessionAndSendPrompt(
    env,
    result.target,
    channel,
    threadKey,
    messageText,
    user,
    previousMessages,
    channelName,
    channelDescription,
    traceId
  );
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
