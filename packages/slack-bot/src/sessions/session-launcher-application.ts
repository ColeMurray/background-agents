import type { CreateSessionResponse } from "@open-inspect/shared/types/session-api";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import type { ModelOption } from "../app-home/slack-types";
import type {
  PreparedImageAttachments,
  SlackAttachmentDropReason,
  SlackImageAttachment,
} from "../attachments";
import { formatChannelContext, formatThreadContext } from "../messages/context";
import { branchPreferenceRepo, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env, ThreadSession } from "../types";
import type { SlackActorIdentity } from "../user-identity";
import type { ResolvedUserPreferences } from "../user-preferences";
import type { SlackSettings } from "../slack-settings";
import type { DeliverPromptOptions, DeliverPromptResult } from "./prompt-delivery";

export interface StartSessionOptions {
  target: SlackSessionTarget;
  channel: string;
  threadTs: string;
  messageText: string;
  actor: SlackActorIdentity;
  /** Slack ts persisted so follow-ups only include newer thread messages. */
  messageTs?: string;
  previousMessages?: string[];
  channelName?: string;
  channelDescription?: string;
  images?: SlackImageAttachment[];
  imageOnly?: boolean;
  traceId?: string;
}

interface CreateSessionOptions {
  target: SlackSessionTarget;
  model: string;
  reasoningEffort?: string;
  branch?: string;
  traceId?: string;
  slackUserId?: string;
  actorDisplayName?: string;
  actorEmail?: string;
}

/** Application-owned ports needed to launch a session from Slack. */
export interface SessionLauncherDependencies {
  getAvailableModels(env: Env, traceId?: string): Promise<ModelOption[]>;
  getSlackSettings(env: Env, traceId?: string): Promise<SlackSettings>;
  getResolvedUserPreferences(
    env: Env,
    userId: string,
    options: { defaultModel?: string; enabledModels?: string[] }
  ): Promise<ResolvedUserPreferences>;
  getUserRepoBranchPreference(
    env: Env,
    userId: string,
    repoId: string
  ): Promise<string | undefined>;
  createSession(env: Env, options: CreateSessionOptions): Promise<CreateSessionResponse | null>;
  prepareImageAttachments(
    env: Env,
    attachments: SlackImageAttachment[],
    traceId?: string
  ): Promise<PreparedImageAttachments>;
  notifyDroppedAttachments(
    env: Env,
    channel: string,
    threadTs: string,
    result: {
      references: SessionAttachmentReference[];
      dropped: SlackAttachmentDropReason[];
    },
    options: { traceId?: string; nothingSent: true }
  ): Promise<void>;
  deliverPrompt(env: Env, options: DeliverPromptOptions): Promise<DeliverPromptResult>;
  postMessage(
    token: string,
    channel: string,
    text: string,
    options: { thread_ts: string }
  ): Promise<unknown>;
  buildThreadSession(
    sessionId: string,
    target: SlackSessionTarget,
    model: string,
    reasoningEffort?: string,
    lastPromptTs?: string
  ): ThreadSession;
  storeThreadSession(
    env: Env,
    channel: string,
    threadTs: string,
    session: ThreadSession
  ): Promise<void>;
}

export function createSessionLauncher(dependencies: SessionLauncherDependencies) {
  return async function startSessionAndSendPrompt(
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
      imageOnly,
      traceId,
    } = options;
    // Download images first so total loss on an image-only request cannot create
    // a session that receives no meaningful prompt.
    const preparedImages = await dependencies.prepareImageAttachments(env, images ?? [], traceId);
    if (imageOnly && preparedImages.files.length === 0) {
      await dependencies.notifyDroppedAttachments(
        env,
        channel,
        threadTs,
        { references: [], dropped: preparedImages.dropped },
        { traceId, nothingSent: true }
      );
      return null;
    }
    const [availableModels, slackConfig] = await Promise.all([
      dependencies.getAvailableModels(env, traceId),
      dependencies.getSlackSettings(env, traceId),
    ]);
    const userPrefs = await dependencies.getResolvedUserPreferences(env, actor.userId, {
      defaultModel: slackConfig.defaultModel ?? env.DEFAULT_MODEL,
      enabledModels: availableModels.map((modelOption) => modelOption.value),
    });
    const { model, reasoningEffort } = userPrefs;
    const preferenceRepo = branchPreferenceRepo(target);
    let branch: string | undefined;
    if (preferenceRepo) {
      const repoBranch = await dependencies.getUserRepoBranchPreference(
        env,
        actor.userId,
        preferenceRepo.id
      );
      branch = repoBranch ?? userPrefs.branch;
    }

    const session = await dependencies.createSession(env, {
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
      await dependencies.postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, I couldn't create a session. Please try again.",
        { thread_ts: threadTs }
      );
      return null;
    }

    const callbackContext = {
      source: "slack" as const,
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
    const delivery = await dependencies.deliverPrompt(env, {
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
      // Image-only total loss already produced its specific user-facing notice.
      if (delivery.reason !== "no_images_delivered") {
        await dependencies.postMessage(
          env.SLACK_BOT_TOKEN,
          channel,
          "Session created but failed to send prompt. Please try again.",
          { thread_ts: threadTs }
        );
      }
      return null;
    }
    await dependencies.storeThreadSession(
      env,
      channel,
      threadTs,
      dependencies.buildThreadSession(session.sessionId, target, model, reasoningEffort, messageTs)
    );
    return { sessionId: session.sessionId };
  };
}
