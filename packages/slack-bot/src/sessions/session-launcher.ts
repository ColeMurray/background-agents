import { getUserInfo, postMessage, type CallbackContext } from "@open-inspect/shared";
import { getAvailableModels, getSlackDefaultModel } from "../app-home/models";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { formatChannelContext, formatThreadContext } from "../messages/context";
import { branchPreferenceRepo, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env } from "../types";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession, sendPrompt } from "./control-plane-client";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";

export async function startSessionAndSendPrompt(
  env: Env,
  target: SlackSessionTarget,
  channel: string,
  threadTs: string,
  messageText: string,
  userId: string,
  previousMessages?: string[],
  channelName?: string,
  channelDescription?: string,
  traceId?: string
): Promise<{ sessionId: string } | null> {
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

  const session = await createSession(
    env,
    target,
    model,
    reasoningEffort,
    branch,
    traceId,
    userId,
    displayName,
    email
  );
  if (!session) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't create a session. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }

  await storeThreadSession(
    env,
    channel,
    threadTs,
    buildThreadSession(session.sessionId, target, model, reasoningEffort)
  );
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
  const promptResult = await sendPrompt(
    env,
    session.sessionId,
    channelContext + threadContext + messageText,
    `slack:${userId}`,
    callbackContext,
    traceId
  );
  if (!promptResult) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Session created but failed to send prompt. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }
  return { sessionId: session.sessionId };
}
