import { postMessage } from "@open-inspect/shared/slack";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import { normalizeValidModels, type ValidModel } from "@open-inspect/shared/models";
import { getAuthoritativeModels, getAvailableModels } from "../app-home/models";
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
import { getResolvedUserPreferences, type ResolvedUserPreferences } from "../user-preferences";
import { createSession } from "./control-plane-client";
import { getSlackSettings, type SlackSettings } from "../slack-settings";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import {
  EMPTY_INLINE_PROMPT_OPTIONS,
  normalizeModelSelection,
  resolveInlinePromptOptions,
  sameModelSelection,
  type ModelSelection,
  type SessionLaunchPlan,
} from "../inline-flags";

export interface SlackLaunchSettings {
  enabledModels: ValidModel[];
  slackConfig: SlackSettings;
  userPreferences: ResolvedUserPreferences;
}

async function resolveSlackLaunchSettings(
  env: Env,
  userId: string,
  enabledModels: ValidModel[],
  slackConfig: SlackSettings
): Promise<SlackLaunchSettings> {
  const userPreferences = await getResolvedUserPreferences(env, userId, {
    defaultModel: slackConfig.defaultModel ?? env.DEFAULT_MODEL,
    enabledModels,
  });
  return { enabledModels, slackConfig, userPreferences };
}

export async function loadSlackLaunchSettings(
  env: Env,
  userId: string,
  traceId?: string
): Promise<SlackLaunchSettings> {
  const [availableModels, slackConfig] = await Promise.all([
    getAvailableModels(env, traceId),
    getSlackSettings(env, traceId),
  ]);
  return resolveSlackLaunchSettings(
    env,
    userId,
    normalizeValidModels(availableModels.map((modelOption) => modelOption.value)),
    slackConfig
  );
}

export async function loadAuthoritativeSlackLaunchSettings(
  env: Env,
  userId: string,
  traceId?: string
): Promise<SlackLaunchSettings | null> {
  const [enabledModels, slackConfig] = await Promise.all([
    getAuthoritativeModels(env, traceId),
    getSlackSettings(env, traceId),
  ]);
  return enabledModels ? resolveSlackLaunchSettings(env, userId, enabledModels, slackConfig) : null;
}

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
  launchPlan?: SessionLaunchPlan;
  launchSettings?: SlackLaunchSettings;
  traceId?: string;
}

/** What the session was actually created with, for the acknowledgement. */
export interface StartSessionResult {
  sessionId: string;
  sessionDefaults: ModelSelection;
  /** True when those are not the user's App Home preferences. */
  differsFromUserDefaults: boolean;
}

export async function startSessionAndSendPrompt(
  env: Env,
  options: StartSessionOptions
): Promise<StartSessionResult | null> {
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
    launchPlan,
    launchSettings: providedLaunchSettings,
    traceId,
  } = options;
  // Download image bytes before creating the session: an image-only request
  // whose images are all lost must never create a session it will not prompt.
  const preparedImages = await preparePromptImageAttachments(
    env,
    images ?? [],
    imageOnly ? [] : (contextImages ?? []),
    traceId
  );
  if (imageOnly && preparedImages.files.length === 0) {
    await notifyDroppedAttachments(
      env,
      channel,
      threadTs,
      { references: [], dropped: preparedImages.dropped },
      { traceId, nothingSent: true }
    );
    return null;
  }
  const {
    enabledModels,
    slackConfig,
    userPreferences: userPrefs,
  } = providedLaunchSettings ?? (await loadSlackLaunchSettings(env, actor.userId, traceId));
  // Whatever the caller asked for is only intent: a plan can be minutes or
  // hours old by the time a deferred target selection reaches this point, so
  // the enabled-model set is applied here, against the list just loaded.
  const requestedDefaults = resolveInlinePromptOptions(
    EMPTY_INLINE_PROMPT_OPTIONS,
    launchPlan?.sessionDefaults ?? userPrefs,
    enabledModels
  );
  if (!requestedDefaults.ok) {
    await postMessage(env.SLACK_BOT_TOKEN, channel, requestedDefaults.error, {
      thread_ts: threadTs,
    });
    return null;
  }
  const sessionDefaults = requestedDefaults.turnPlan.effective;
  const { model, reasoningEffort } = sessionDefaults;
  const differsFromUserDefaults = !sameModelSelection(
    sessionDefaults,
    normalizeModelSelection(userPrefs)
  );
  const preferenceRepo = branchPreferenceRepo(target);
  let branch: string | undefined;
  if (preferenceRepo) {
    const repoBranch = await getUserRepoBranchPreference(env, actor.userId, preferenceRepo.id);
    branch = repoBranch ?? userPrefs.branch;
  }

  const session = await createSession(env, {
    target,
    model,
    reasoningEffort,
    branch,
    traceId,
    slackUserId: actor.userId,
    actorDisplayName: actor.displayName,
    actorEmail: actor.email,
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
    model: launchPlan?.promptOverrides?.model ?? model,
    reasoningEffort: launchPlan?.promptOverrides?.reasoningEffort ?? reasoningEffort,
  };
  const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
  const threadContext = previousMessages ? formatThreadContext(previousMessages) : "";
  let content = channelContext + threadContext + messageText;
  if (slackConfig.sessionInstructions) {
    content += `\n\n## Additional Instructions\n\n${slackConfig.sessionInstructions}`;
  }
  const delivery = await deliverPrompt(env, {
    sessionId: session.sessionId,
    content,
    authorId: `slack:${actor.userId}`,
    attachments: preparedImages,
    imageOnly: Boolean(imageOnly),
    callbackContext,
    // Normally empty — the session was just created with these settings. It is
    // set only when recovering a stale thread, where the replacement keeps the
    // thread's defaults and the follow-up's own flags stay a one-turn override.
    ...launchPlan?.promptOverrides,
    channel,
    threadTs,
    traceId,
  });
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
  return { sessionId: session.sessionId, sessionDefaults, differsFromUserDefaults };
}
