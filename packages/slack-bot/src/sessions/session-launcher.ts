import {
  getUserInfo,
  postMessage,
  type CallbackContext,
  type SlackMessageFile,
} from "@open-inspect/shared";
import { getAvailableModels, getSlackDefaultModel } from "../app-home/models";
import { notifyDroppedAttachments, uploadSlackImageAttachments } from "../attachments";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { formatChannelContext, formatThreadContext } from "../messages/context";
import { branchPreferenceRepo, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env } from "../types";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession, sendPrompt } from "./control-plane-client";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";

export interface StartSessionOptions {
  target: SlackSessionTarget;
  channel: string;
  threadTs: string;
  messageText: string;
  userId: string;
  /**
   * Slack ts of the triggering message. Persisted on the thread mapping so
   * follow-ups can scope interim thread context to newer messages.
   */
  messageTs?: string;
  previousMessages?: string[];
  channelName?: string;
  channelDescription?: string;
  /** Files attached to the triggering Slack message; images are forwarded. */
  files?: SlackMessageFile[];
  traceId?: string;
}

export async function startSessionAndSendPrompt(
  env: Env,
  options: StartSessionOptions
): Promise<{ sessionId: string } | null> {
  const {
    target,
    channel,
    threadTs,
    messageText,
    userId,
    messageTs,
    previousMessages,
    channelName,
    channelDescription,
    files,
    traceId,
  } = options;
  const [availableModels, slackDefaultModel] = await Promise.all([
    getAvailableModels(env, traceId),
    getSlackDefaultModel(env, traceId),
  ]);
  const userPrefs = await getResolvedUserPreferences(env, userId, {
    defaultModel: slackDefaultModel ?? env.DEFAULT_MODEL,
    enabledModels: availableModels.map((modelOption) => modelOption.value),
  });
  const model = userPrefs.model;
  const reasoningEffort = userPrefs.reasoningEffort;
  const preferenceRepo = branchPreferenceRepo(target);
  let branch: string | undefined;
  if (preferenceRepo) {
    const repoBranch = await getUserRepoBranchPreference(env, userId, preferenceRepo.id);
    branch = repoBranch ?? userPrefs.branch;
  }

  let displayName: string | undefined;
  let email: string | undefined;
  try {
    const userInfo = await getUserInfo(env.SLACK_BOT_TOKEN, userId);
    if (userInfo.ok) {
      displayName =
        userInfo.user.profile?.display_name ||
        userInfo.user.real_name ||
        userInfo.user.name ||
        undefined;
      email = userInfo.user.profile?.email || undefined;
    }
  } catch {
    // Identity linking is best effort.
  }

  const session = await createSession(env, {
    target,
    model,
    reasoningEffort,
    branch,
    traceId,
    slackUserId: userId,
    actorDisplayName: displayName,
    actorEmail: email,
  });
  if (!session) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't create a session. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }

  const callbackContext: CallbackContext = {
    source: "slack",
    channel,
    threadTs,
    repoFullName: targetLabel(target),
    model,
    reasoningEffort,
  };
  const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
  const threadContext = previousMessages ? formatThreadContext(previousMessages) : "";
  const uploadResult = await uploadSlackImageAttachments(env, session.sessionId, files, traceId);
  const promptResult = await sendPrompt(
    env,
    session.sessionId,
    channelContext + threadContext + messageText,
    `slack:${userId}`,
    callbackContext,
    traceId,
    uploadResult.references
  );
  if (!promptResult.ok) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Session created but failed to send prompt. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }
  // Only notify about dropped images once the prompt landed — a failed prompt
  // already gets its own error message above.
  await notifyDroppedAttachments(env, channel, threadTs, uploadResult, traceId);
  await storeThreadSession(
    env,
    channel,
    threadTs,
    buildThreadSession(session.sessionId, target, model, reasoningEffort, messageTs)
  );
  return { sessionId: session.sessionId };
}
