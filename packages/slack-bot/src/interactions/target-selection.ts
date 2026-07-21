import { escapeMrkdwnText, postMessage, updateMessage } from "@open-inspect/shared";
import {
  buildWorkingMessageBlocks,
  scheduleStartingStatus,
  type BackgroundTaskScheduler,
} from "../messages/blocks";
import { deletePendingRequest, getPendingRequest } from "../pending-requests/pending-request-store";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";
import { targetLabel } from "../targets";
import type { Env } from "../types";

export async function handleTargetSelection(
  selectedValue: string,
  channel: string,
  messageTs: string,
  threadTs: string | undefined,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  const threadKey = threadTs || messageTs;
  const pendingData = await getPendingRequest(env, channel, threadKey);
  if (!pendingData) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't find your original request. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  const { message, userId, previousMessages, channelName, channelDescription, files } = pendingData;
  const target = await resolveTargetValue(env, selectedValue, traceId);
  if (!target) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, that repository or environment is no longer available. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  const label = escapeMrkdwnText(targetLabel(target));
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  const ackResult = await postMessage(env.SLACK_BOT_TOKEN, channel, `Working on *${label}*...`, {
    thread_ts: threadKey,
    blocks: buildWorkingMessageBlocks(label),
  });
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  const sessionResult = await startSessionAndSendPrompt(env, {
    target,
    channel,
    threadTs: threadKey,
    messageText: message,
    userId,
    // The original message ts isn't persisted with the pending request, so
    // the "Working on..." ack — or the interaction message when the ack post
    // fails — marks where interim thread context resumes.
    messageTs: ackTs ?? messageTs,
    previousMessages,
    channelName,
    channelDescription,
    files,
    traceId,
  });
  if (!sessionResult) return;

  await deletePendingRequest(env, channel, threadKey);
  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${label}*...`, {
      blocks: buildWorkingMessageBlocks(label, {
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}
