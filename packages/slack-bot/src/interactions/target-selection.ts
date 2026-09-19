import {
  getMessageDetails,
  postEphemeral,
  postMessage,
  updateMessage,
} from "@open-inspect/shared/slack";
import { toImageAttachments, type SlackImageAttachment } from "../attachments";
import { MODEL_PREFERENCES_UNAVAILABLE_MESSAGE } from "../app-home/models";
import { collectForwardedMessages } from "../forwarded-messages";
import { fetchInteractiveThreadContext } from "../interactive-thread-context";
import { createLogger } from "../logger";
import {
  buildWorkingMessageBlocks,
  scheduleStartingStatus,
  type BackgroundTaskScheduler,
} from "../messages/blocks";
import { formatAttributedRequest } from "../messages/context";
import {
  deleteLegacyPendingRequest,
  deletePendingRequest,
  getLegacyPendingRequest,
  getPendingRequest,
} from "../pending-requests/pending-request-store";
import {
  loadAuthoritativeSlackLaunchSettings,
  startSessionAndSendPrompt,
  type SlackLaunchSettings,
} from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";
import { targetId } from "../targets";
import type { Env } from "../types";
import { resolveSlackActorIdentity } from "../user-identity";
import { hasInlinePromptOptions, resolveInlinePromptOptions } from "../inline-flags";

const log = createLogger("target-selection");

interface TargetSelectionRequest {
  requestId?: string;
  selectedValue: string;
  channel: string;
  messageTs: string;
  threadTs?: string;
  selectedBy: string;
  selectionSource: "picker" | "quick_pick";
}

export async function handleTargetSelection(
  request: TargetSelectionRequest,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  const { requestId, selectedValue, channel, messageTs, threadTs, selectedBy, selectionSource } =
    request;
  const threadKey = threadTs || messageTs;
  let pendingData;
  if (requestId) {
    const boundPendingData = await getPendingRequest(env, requestId);
    if (
      boundPendingData &&
      (boundPendingData.channel !== channel || boundPendingData.threadTs !== threadKey)
    ) {
      await postEphemeral(
        env.SLACK_BOT_TOKEN,
        channel,
        selectedBy,
        "Sorry, this target selection no longer matches its original request.",
        { thread_ts: threadKey }
      );
      return;
    }
    pendingData = boundPendingData;
  } else {
    pendingData = await getLegacyPendingRequest(env, channel, threadKey);
  }

  if (!pendingData) {
    await postEphemeral(
      env.SLACK_BOT_TOKEN,
      channel,
      selectedBy,
      "Sorry, this target selection has expired. Please try your request again.",
      { thread_ts: threadKey }
    );
    return;
  }

  const {
    message,
    userId,
    previousMessages,
    channelName,
    channelDescription,
    imageOnly,
    messageTs: sourceMessageTs,
    sourceMessage,
    threadContextSource,
    unattributedPrompt,
    turnPlan,
    classification,
  } = pendingData;
  if (selectedBy !== userId) {
    await postEphemeral(
      env.SLACK_BOT_TOKEN,
      channel,
      selectedBy,
      "Only the person who made the original request can choose its target.",
      { thread_ts: threadKey }
    );
    return;
  }
  const legacyInlinePromptOptions =
    !requestId && "inlinePromptOptions" in pendingData
      ? pendingData.inlinePromptOptions
      : undefined;
  let resolvedTurnPlan = turnPlan;
  let launchSettings: SlackLaunchSettings | undefined;
  if (
    !resolvedTurnPlan &&
    legacyInlinePromptOptions &&
    hasInlinePromptOptions(legacyInlinePromptOptions)
  ) {
    const authoritativeLaunchSettings = await loadAuthoritativeSlackLaunchSettings(
      env,
      userId,
      traceId
    );
    if (!authoritativeLaunchSettings) {
      await postMessage(env.SLACK_BOT_TOKEN, channel, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE, {
        thread_ts: threadKey,
      });
      return;
    }
    launchSettings = authoritativeLaunchSettings;
    const resolvedTurn = resolveInlinePromptOptions(
      legacyInlinePromptOptions,
      launchSettings.userPreferences,
      launchSettings.enabledModels
    );
    if (!resolvedTurn.ok) {
      await postMessage(env.SLACK_BOT_TOKEN, channel, resolvedTurn.error, {
        thread_ts: threadKey,
      });
      return;
    }
    resolvedTurnPlan = resolvedTurn.turnPlan;
  }
  const target = await resolveTargetValue(env, selectedValue, traceId);
  if (!target) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, that target is no longer available. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  const contextImages = threadContextSource
    ? (
        await fetchInteractiveThreadContext(
          env,
          channel,
          threadContextSource.threadTs,
          { beforeTs: threadContextSource.beforeTs, includeBotMessages: true },
          traceId
        )
      )?.images
    : undefined;

  // Pending requests persist only the source-message locator; re-fetch the
  // files from Slack now that the target is known.
  let images: SlackImageAttachment[] = [];
  if (sourceMessage) {
    const lookup = await getMessageDetails(
      env.SLACK_BOT_TOKEN,
      channel,
      sourceMessage.ts,
      sourceMessage.threadTs
    );
    if (lookup.ok) {
      // The pending prompt already preserves any forwarded-message text, but
      // its images live on the attachment and are re-fetched here like the rest.
      const forwarded = collectForwardedMessages(lookup.attachments);
      images = toImageAttachments([...lookup.files, ...forwarded.files], traceId);
    } else {
      log.warn("slack.attachment.file_lookup_failed", {
        trace_id: traceId,
        channel,
        message_ts: sourceMessage.ts,
        slack_error: lookup.error,
      });
    }
    if (imageOnly && images.length === 0) {
      // The request had no text: without its images there is nothing to run.
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, I couldn't retrieve the attached image(s) from Slack, so I didn't start on this request. Please try again.",
        { thread_ts: threadKey }
      );
      return;
    }
  }

  log.info("target.decision", {
    trace_id: traceId,
    request_id: requestId,
    channel,
    thread_ts: threadKey,
    decision_path: "clarified",
    classification_source: classification?.source,
    classifier_target_id: classification?.targetId,
    classifier_confidence: classification?.confidence,
    selected_by: selectedBy,
    selection_source: selectionSource,
    target_kind: target.kind,
    target_id: targetId(target),
  });
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  const ackResult = await postMessage(env.SLACK_BOT_TOKEN, channel, "Starting work...", {
    thread_ts: threadKey,
    blocks: buildWorkingMessageBlocks(),
  });
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  const actor = await resolveSlackActorIdentity(env.SLACK_BOT_TOKEN, userId);
  // Records written before deferred attribution already contain deliverable text.
  const messageText = unattributedPrompt
    ? formatAttributedRequest(actor.senderLabel, message, unattributedPrompt.forwardedMessages)
    : message;
  const sessionResult = await startSessionAndSendPrompt(env, {
    target,
    channel,
    threadTs: threadKey,
    messageText,
    actor,
    // New records preserve the original causal checkpoint. The fallback keeps
    // pending requests written by older deployments deliverable.
    messageTs: sourceMessageTs ?? ackTs ?? messageTs,
    previousMessages,
    channelName,
    channelDescription,
    images,
    contextImages,
    imageOnly,
    turnPlan: resolvedTurnPlan,
    launchSettings,
    traceId,
  });
  if (!sessionResult) return;

  if (requestId) {
    await deletePendingRequest(env, requestId);
  } else {
    await deleteLegacyPendingRequest(env, channel, threadKey);
  }
  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, "Starting work...", {
      blocks: buildWorkingMessageBlocks({
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}
