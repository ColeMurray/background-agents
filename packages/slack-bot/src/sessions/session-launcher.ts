import { escapeMrkdwnText, postMessage } from "@open-inspect/shared/slack";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import type { ValidModel } from "@open-inspect/shared/models";
import { checkHarnessCompatibility } from "@open-inspect/shared/harnesses";
import { getAuthoritativeModels, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE } from "../app-home/models";
import {
  notifyDroppedAttachments,
  preparePromptImageAttachments,
  type SlackImageAttachment,
} from "../attachments";
import { getUserRepoBranchPreference } from "../branch-preferences";
import {
  formatDisabledModelLaunchRefusal,
  formatHarnessLaunchRefusal,
  type LaunchModelSource,
} from "../messages/blocks";
import { formatChannelContext, formatThreadContext } from "../messages/context";
import { branchPreferenceRepo, targetLabel, type SlackSessionTarget } from "../targets";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { SlackActorIdentity } from "../user-identity";
import {
  getAuthoritativeUserPreferences,
  resolveUserPreferences,
  type ResolvedUserPreferences,
} from "../user-preferences";
import { createSession } from "./control-plane-client";
import { getAuthoritativeSlackSettings, type SlackSettings } from "../slack-settings";
import { deliverPrompt } from "./prompt-delivery";
import { buildThreadSession, storeThreadSession } from "./thread-session-store";
import {
  normalizeModelSelection,
  sameModelSelection,
  type ModelSelection,
  type SessionLaunchPlan,
} from "../inline-flags";

const log = createLogger("session-launcher");

export interface SlackLaunchSettings {
  enabledModels: ValidModel[];
  slackConfig: SlackSettings;
  userPreferences: ResolvedUserPreferences;
  modelSource: Exclude<LaunchModelSource, "request">;
}

export async function loadAuthoritativeSlackLaunchSettings(
  env: Env,
  userId: string,
  traceId?: string
): Promise<SlackLaunchSettings | null> {
  try {
    const [enabledModels, slackConfig, prefs] = await Promise.all([
      getAuthoritativeModels(env, traceId),
      getAuthoritativeSlackSettings(env, traceId),
      getAuthoritativeUserPreferences(env, userId),
    ]);
    if (!enabledModels || !slackConfig) return null;
    const userPreferences = resolveUserPreferences(
      prefs,
      slackConfig.defaultModel ?? env.DEFAULT_MODEL,
      slackConfig.harness
    );
    const modelSource =
      userPreferences.modelOrigin === "app-home"
        ? "app-home"
        : slackConfig.defaultModel
          ? "slack-default"
          : "system-default";
    return { enabledModels, slackConfig, userPreferences, modelSource };
  } catch (error) {
    log.warn("slack.launch_settings.unavailable", {
      trace_id: traceId,
      user_id: userId,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
}

export interface StartSessionOptions {
  target: SlackSessionTarget;
  teamId?: string | null;
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
    teamId,
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
  const launchSettings =
    providedLaunchSettings ??
    (await loadAuthoritativeSlackLaunchSettings(env, actor.userId, traceId));
  if (!launchSettings) {
    await postMessage(env.SLACK_BOT_TOKEN, channel, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE, {
      thread_ts: threadTs,
    });
    return null;
  }
  const { enabledModels, slackConfig, userPreferences: userPrefs, modelSource } = launchSettings;
  // Deferred plans may outlive a model's enablement. Refuse the selected model
  // rather than substituting one the user never chose.
  const sessionDefaults = normalizeModelSelection(launchPlan?.sessionDefaults ?? userPrefs);
  const { model, reasoningEffort } = sessionDefaults;
  if (!enabledModels.includes(model)) {
    const source = launchPlan ? "request" : modelSource;
    log.info("slack.session.disabled_model_refused", { trace_id: traceId, model, source });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      formatDisabledModelLaunchRefusal(model, source),
      { thread_ts: threadTs }
    );
    return null;
  }
  const differsFromUserDefaults = !sameModelSelection(
    sessionDefaults,
    normalizeModelSelection(userPrefs)
  );
  // The harness is the user's App Home choice, else the workspace setting. A
  // model it cannot run is refused, never moved to another harness, so a
  // session always runs where the user expects.
  const { harness } = userPrefs;
  const incompatibility = checkHarnessCompatibility(harness, model);
  if (incompatibility) {
    log.info("slack.session.harness_model_refused", { trace_id: traceId, harness, model });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      formatHarnessLaunchRefusal(incompatibility.message, harness),
      { thread_ts: threadTs }
    );
    return null;
  }
  const preferenceRepo = branchPreferenceRepo(target);
  let branch: string | undefined;
  if (preferenceRepo) {
    const repoBranch = await getUserRepoBranchPreference(env, actor.userId, preferenceRepo.id);
    branch = repoBranch ?? userPrefs.branch;
  }

  const session = await createSession(env, {
    target,
    teamId,
    harness,
    model,
    reasoningEffort,
    branch,
    traceId,
    slackUserId: actor.userId,
    actorDisplayName: actor.displayName,
    actorEmail: actor.email,
  });
  if (!session || "error" in session) {
    const failure = session?.error;
    let message = "Sorry, I couldn't create a session. Please try again.";
    if (
      failure?.status === 403 &&
      (failure.code === "not_member" ||
        (failure.code === "session_action_denied" && failure.reasonCode === "not_member"))
    ) {
      message = "you are not a member of this channel's team";
    } else if (
      failure?.status === 409 &&
      failure.code === "target_team_missing_grant" &&
      failure.repository
    ) {
      message = `This channel's team does not have access to repository ${escapeMrkdwnText(failure.repository)}.`;
    }
    await postMessage(env.SLACK_BOT_TOKEN, channel, message, { thread_ts: threadTs });
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
    buildThreadSession(session.sessionId, target, model, reasoningEffort, messageTs, teamId)
  );
  return { sessionId: session.sessionId, sessionDefaults, differsFromUserDefaults };
}
