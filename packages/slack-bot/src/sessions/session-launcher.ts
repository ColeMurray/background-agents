import { postMessage } from "@open-inspect/shared/slack";
import { getAvailableModels } from "../app-home/models";
import {
  notifyDroppedAttachments,
  preparePromptImageAttachments,
  type SlackImageAttachment,
} from "../attachments";
import { getUserRepoBranchPreference } from "../branch-preferences";
import { formatChannelContext, formatThreadContext } from "../messages/context";
import { branchPreferenceRepo, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env } from "../types";
import type { SlackActorIdentity } from "../user-identity";
import { getResolvedUserPreferences } from "../user-preferences";
import { createSession } from "./control-plane-client";
import { getSlackSettings } from "../slack-settings";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import type { SessionLaunchSnapshot } from "../pending-requests/pending-request-store";

export interface StartSessionOptions {
  target: SlackSessionTarget;
  channel: string;
  threadTs: string;
  messageText: string;
  actor: SlackActorIdentity;
  /**
   * Slack ts of the triggering message. Persisted on the thread mapping so
   * follow-ups can scope interim thread context to newer messages.
   */
  messageTs?: string;
  previousMessages?: string[];
  channelName?: string;
  channelDescription?: string;
  /** Images attached to the triggering Slack message, normalized at ingress. */
  images?: SlackImageAttachment[];
  /** Supported images from earlier messages in the selected causal window. */
  contextImages?: SlackImageAttachment[];
  /** True when the triggering message had no user text, only images. */
  imageOnly?: boolean;
  traceId?: string;
  clientRequestId?: string;
  existingSessionId?: string;
  launchSnapshot?: SessionLaunchSnapshot;
  onLaunchPrepared?: (
    snapshot: SessionLaunchSnapshot,
    sessionId?: string
  ) => Promise<SessionLaunchSnapshot>;
  onSessionCreated?: (
    sessionId: string,
    previousSessionId: string | undefined,
    snapshot: SessionLaunchSnapshot
  ) => Promise<SessionLaunchSnapshot>;
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
    actor,
    messageTs,
    previousMessages,
    channelName,
    channelDescription,
    images,
    contextImages,
    imageOnly,
    traceId,
    clientRequestId,
    existingSessionId,
    launchSnapshot,
    onLaunchPrepared,
    onSessionCreated,
  } = options;
  const persistedAttachmentReferences = launchSnapshot?.attachmentReferences;
  // Download before creating the session so a stale replacement can re-upload.
  // Persisted references still let an ordinary replay proceed if Slack is unavailable.
  const preparedImages = await preparePromptImageAttachments(
    env,
    images ?? [],
    imageOnly ? [] : (contextImages ?? []),
    traceId
  );
  if (
    imageOnly &&
    persistedAttachmentReferences === undefined &&
    preparedImages.files.length === 0
  ) {
    await notifyDroppedAttachments(
      env,
      channel,
      threadTs,
      { references: [], dropped: preparedImages.dropped },
      { traceId, nothingSent: true }
    );
    return null;
  }
  let snapshot = launchSnapshot;
  if (!snapshot) {
    const [availableModels, slackConfig] = await Promise.all([
      getAvailableModels(env, traceId),
      getSlackSettings(env, traceId),
    ]);
    const userPrefs = await getResolvedUserPreferences(env, actor.userId, {
      defaultModel: slackConfig.defaultModel ?? env.DEFAULT_MODEL,
      enabledModels: availableModels.map((modelOption) => modelOption.value),
    });
    let branch: string | undefined;
    const preferenceRepo = branchPreferenceRepo(target);
    if (preferenceRepo) {
      const repoBranch = await getUserRepoBranchPreference(env, actor.userId, preferenceRepo.id);
      branch = repoBranch ?? userPrefs.branch;
    }
    const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
    const threadContext = previousMessages ? formatThreadContext(previousMessages) : "";
    let content = channelContext + threadContext + messageText;
    if (slackConfig.sessionInstructions) {
      content += `\n\n## Additional Instructions\n\n${slackConfig.sessionInstructions}`;
    }
    snapshot = {
      model: userPrefs.model,
      reasoningEffort: userPrefs.reasoningEffort,
      branch,
      content,
      callbackContext: {
        source: "slack",
        channel,
        threadTs,
        repoFullName: targetLabel(target),
        model: userPrefs.model,
        reasoningEffort: userPrefs.reasoningEffort,
      },
    };
    if (onLaunchPrepared) {
      try {
        snapshot = await onLaunchPrepared(snapshot, existingSessionId);
      } catch {
        await postMessage(
          env.SLACK_BOT_TOKEN,
          channel,
          "Failed to save launch state. Please try again.",
          { thread_ts: threadTs }
        );
        return null;
      }
    }
  }
  let deliverySnapshot: SessionLaunchSnapshot = snapshot;
  const { model, reasoningEffort, branch, content, callbackContext } = deliverySnapshot;

  const createNewSession = () =>
    createSession(env, {
      target,
      model,
      reasoningEffort,
      branch,
      traceId,
      slackUserId: actor.userId,
      actorDisplayName: actor.displayName,
      actorEmail: actor.email,
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  let session = existingSessionId ? { sessionId: existingSessionId } : await createNewSession();
  if (!session) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't create a session. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }
  const persistSession = async (
    sessionId: string,
    previousSessionId?: string
  ): Promise<boolean> => {
    if (!onSessionCreated) return true;
    try {
      deliverySnapshot = await onSessionCreated(sessionId, previousSessionId, deliverySnapshot);
      return true;
    } catch {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Session created but failed to save its launch state. Please try again.",
        { thread_ts: threadTs }
      );
      return false;
    }
  };
  if (!existingSessionId && !(await persistSession(session.sessionId))) {
    return null;
  }

  const deliver = (sessionId: string) =>
    deliverPrompt(env, {
      sessionId,
      content,
      authorId: `slack:${actor.userId}`,
      attachments: preparedImages,
      imageOnly: Boolean(imageOnly),
      callbackContext,
      channel,
      threadTs,
      traceId,
      ...(deliverySnapshot.attachmentReferences
        ? {
            attachmentReferences: deliverySnapshot.attachmentReferences,
            attachmentDrops: deliverySnapshot.attachmentDrops,
          }
        : {}),
      ...(onLaunchPrepared
        ? {
            onAttachmentsPrepared: async (attachmentReferences, attachmentDrops) => {
              deliverySnapshot = await onLaunchPrepared(
                { ...deliverySnapshot, attachmentReferences, attachmentDrops },
                sessionId
              );
              return {
                references: deliverySnapshot.attachmentReferences ?? attachmentReferences,
                dropped: deliverySnapshot.attachmentDrops ?? attachmentDrops,
              };
            },
          }
        : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  let delivery = await deliver(session.sessionId);
  if (!delivery.ok && delivery.reason === "stale" && existingSessionId && clientRequestId) {
    const replacement = await createNewSession();
    if (replacement) {
      const previousSessionId = session.sessionId;
      session = replacement;
      deliverySnapshot = {
        ...deliverySnapshot,
        attachmentReferences: undefined,
        attachmentDrops: undefined,
      };
      if (!(await persistSession(session.sessionId, previousSessionId))) return null;
      delivery = await deliver(session.sessionId);
    }
  }
  if (!delivery.ok) {
    // "no_images_delivered" already told the user nothing ran; the other
    // failures deserve an explicit retry hint against the created session.
    if (delivery.reason !== "no_images_delivered") {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Session created but failed to send prompt. Please try again.",
        { thread_ts: threadTs }
      );
    }
    return null;
  }
  await storeThreadSession(
    env,
    channel,
    threadTs,
    buildThreadSession(session.sessionId, target, model, reasoningEffort, messageTs)
  );
  return { sessionId: session.sessionId };
}
