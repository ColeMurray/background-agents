import {
  addReaction,
  getChannelInfo,
  getMessageDetails,
  postMessage,
  updateMessage,
} from "@open-inspect/shared/slack";
import type { CallbackContext } from "@open-inspect/shared/types/session-api";
import type { SlackMessageAttachment, SlackMessageFile } from "@open-inspect/shared/slack";
import {
  IMAGE_ONLY_PROMPT_TEXT,
  preparePromptImageAttachments,
  toImageAttachments,
  type SlackImageAttachment,
} from "../attachments";
import { createClassifier } from "../classifier";
import {
  CHANNEL_BINDING_UNAVAILABLE_MESSAGE,
  lookupChannelBinding,
  resolveChannelBinding,
} from "../channel-bindings";
import { loadTargetCatalog } from "../classifier/catalog";
import { stripMentions } from "../dm-utils";
import {
  collectForwardedMessages,
  FORWARD_ONLY_PROMPT_TEXT,
  type ForwardedMessages,
} from "../forwarded-messages";
import { createLogger } from "../logger";
import { fetchInteractiveThreadContext } from "../interactive-thread-context";
import {
  buildWorkingMessage,
  formatHarnessModelRefusal,
  formatSessionDefaultsNotice,
  scheduleStartingStatus,
} from "../messages/blocks";
import {
  formatAttributedRequest,
  formatChannelContext,
  formatForwardedContext,
  formatInterimThreadContext,
} from "../messages/context";
import { storePendingRequest } from "../pending-requests/pending-request-store";
import { deliverPrompt } from "../sessions/prompt-delivery";
import { checkPublicationAccess } from "../sessions/control-plane-client";
import {
  loadAuthoritativeSlackLaunchSettings,
  startSessionAndSendPrompt,
  type SlackLaunchSettings,
} from "../sessions/session-launcher";
import {
  advanceLastPromptTs,
  closeThreadSession,
  lookupThreadSession,
  reopenThreadSession,
  THREAD_CLOSED_MESSAGE,
} from "../sessions/thread-session-store";
import { buildTargetClarificationBlocks, getTargetCatalogNotice } from "../target-clarification";
import { targetId } from "../targets";
import type { BackgroundTaskScheduler, Env, ThreadSession } from "../types";
import { resolveSlackActorIdentity, type SlackActorIdentity } from "../user-identity";
import {
  EMPTY_INLINE_PROMPT_OPTIONS,
  hasInlinePromptOptions,
  parseInlinePromptFlags,
  type InlinePromptOptions,
} from "@open-inspect/shared/inline-prompt-flags";
import {
  resolveInlinePromptOptions,
  type ResolvedTurnPlan,
  type SessionLaunchPlan,
} from "../inline-flags";
import { getAuthoritativeModels, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE } from "../app-home/models";

const log = createLogger("handler");

interface IncomingMessageContent {
  text: string;
  inlinePromptOptions: InlinePromptOptions;
  inlineFlagError?: string;
  /** Images attached to the Slack message, normalized at event ingress. */
  images: SlackImageAttachment[];
  /** Quoted bodies, provenance, and files recovered from explicit Slack shares. */
  forwarded: ForwardedMessages;
}

function hasRunnableContent(content: IncomingMessageContent): boolean {
  return Boolean(content.text) || content.images.length > 0 || content.forwarded.hasBody;
}

type ThreadSessionAdmission =
  | { kind: "launch" }
  | { kind: "followUp"; session: ThreadSession; threadTs: string }
  | { kind: "stop" };

interface IncomingMessageParams {
  content: IncomingMessageContent;
  admission: Exclude<ThreadSessionAdmission, { kind: "stop" }>;
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

async function resolveThreadSessionAdmission(
  env: Env,
  channel: string,
  threadTs: string | undefined,
  traceId?: string
): Promise<ThreadSessionAdmission> {
  if (!threadTs) return { kind: "launch" };
  let session = await lookupThreadSession(env, channel, threadTs);
  if (!session) return { kind: "launch" };
  const result = await lookupChannelBinding(env, channel, traceId);
  if (result.kind === "unavailable") {
    log.warn("channel_binding.followup_unavailable", {
      trace_id: traceId,
      channel,
      error: result.error,
    });
    await postMessage(env.SLACK_BOT_TOKEN, channel, CHANNEL_BINDING_UNAVAILABLE_MESSAGE, {
      thread_ts: threadTs,
    });
    return { kind: "stop" };
  }
  // Legacy mappings predate team ownership and represent workspace sessions.
  const bindingMatches =
    result.kind === "resolved" && result.binding.teamId === (session.teamId ?? null);
  if (!session.closed && !bindingMatches) {
    await closeThreadSession(env, channel, threadTs, session.sessionId);
    session = { ...session, closed: true };
  } else if (
    session.closed &&
    bindingMatches &&
    // Bindings and visibility can change back, so a reply re-checks a closure live.
    (await checkPublicationAccess(env, session.sessionId, channel, traceId)) === "allowed"
  ) {
    session = await reopenThreadSession(env, channel, threadTs, session);
    log.info("thread_session.reopened", {
      trace_id: traceId,
      session_id: session.sessionId,
      channel,
      thread_ts: threadTs,
    });
  }
  if (session.closed) {
    await postMessage(env.SLACK_BOT_TOKEN, channel, THREAD_CLOSED_MESSAGE, { thread_ts: threadTs });
    return { kind: "stop" };
  }
  return { kind: "followUp", session, threadTs };
}

/**
 * Route one user message: follow up on the thread's existing session when there
 * is one, otherwise classify the target and launch a new session (or ask for
 * clarification). Image files are forwarded as session attachments, and the
 * bodies of any forwarded Slack messages are quoted into the prompt.
 */
async function handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
  const {
    content,
    admission,
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
  const { text: messageText, images, forwarded, inlinePromptOptions, inlineFlagError } = content;
  const hasInlineOverrides = hasInlinePromptOptions(inlinePromptOptions);
  if (inlineFlagError) {
    await postMessage(env.SLACK_BOT_TOKEN, channel, inlineFlagError, {
      thread_ts: threadTs || ts,
    });
    return;
  }
  if (!hasRunnableContent(content)) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Hi! Please include a message with your request.",
      { thread_ts: threadTs || ts }
    );
    return;
  }
  // A message with no text of its own still needs prompt content for the agent
  // to act on; what it carried instead decides which stand-in to use.
  const imageOnly = !messageText && !forwarded.hasBody;
  const requestText =
    messageText ||
    (forwarded.entries.length > 0 ? FORWARD_ONLY_PROMPT_TEXT : IMAGE_ONLY_PROMPT_TEXT);
  // Forwarded bodies lead: the user's own text ("deal with this") is the
  // instruction and reads as one when it comes last.
  const forwardedContext = formatForwardedContext(forwarded.entries);
  const promptText = forwardedContext + requestText;
  let actor: SlackActorIdentity | undefined;

  if (admission.kind === "followUp") {
    const { session: existingSession, threadTs } = admission;
    let turnPlan: ResolvedTurnPlan | undefined;
    if (hasInlineOverrides) {
      const enabledModels = await getAuthoritativeModels(env, traceId);
      if (!enabledModels) {
        await postMessage(env.SLACK_BOT_TOKEN, channel, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE, {
          thread_ts: threadTs,
        });
        return;
      }
      const resolvedTurn = resolveInlinePromptOptions(
        inlinePromptOptions,
        {
          model: existingSession.model,
          reasoningEffort: existingSession.reasoningEffort,
        },
        enabledModels,
        "keep"
      );
      if (!resolvedTurn.ok) {
        await postMessage(env.SLACK_BOT_TOKEN, channel, resolvedTurn.error, {
          thread_ts: threadTs,
        });
        return;
      }
      turnPlan = resolvedTurn.turnPlan;
    }
    if (hasInlineOverrides) {
      scheduleStartingStatus(scheduleBackground, env, channel, threadTs, traceId);
    }
    const callbackContext: CallbackContext = {
      source: "slack",
      channel,
      threadTs,
      repoFullName: existingSession.repoFullName,
      model: turnPlan?.effective.model ?? existingSession.model,
      reasoningEffort: turnPlan?.effective.reasoningEffort ?? existingSession.reasoningEffort,
      reactionMessageTs: ts,
    };
    const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
    // The session already has its own turns, so only forward the human
    // discussion that happened in the thread since the last prompt.
    const [resolvedActor, interimHistory] = await Promise.all([
      resolveSlackActorIdentity(env.SLACK_BOT_TOKEN, user),
      existingSession.lastPromptTs
        ? fetchInteractiveThreadContext(
            env,
            channel,
            threadTs,
            {
              beforeTs: ts,
              sinceTs: existingSession.lastPromptTs,
              includeBotMessages: false,
            },
            traceId
          )
        : Promise.resolve(undefined),
    ]);
    actor = resolvedActor;
    const interimContext = interimHistory
      ? formatInterimThreadContext(interimHistory.messages)
      : "";
    const promptResult = await deliverPrompt(env, {
      sessionId: existingSession.sessionId,
      content:
        channelContext +
        interimContext +
        formatAttributedRequest(actor.senderLabel, requestText, forwarded.entries),
      authorId: `slack:${user}`,
      attachments: await preparePromptImageAttachments(
        env,
        images,
        imageOnly ? [] : (interimHistory?.images ?? []),
        traceId
      ),
      imageOnly,
      callbackContext,
      ...turnPlan?.promptOverrides,
      channel,
      threadTs,
      traceId,
    });
    if (promptResult.ok) {
      // Only advance the checkpoint past messages we know were considered.
      // When the interim fetch failed, keeping the old watermark lets the
      // next follow-up retry the window; at worst it re-includes this
      // message's text as interim context.
      const interimFetchFailed = Boolean(existingSession.lastPromptTs) && !interimHistory;
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
    if (promptResult.reason === "channel_scope_denied") {
      await closeThreadSession(env, channel, threadTs, existingSession.sessionId);
      await postMessage(env.SLACK_BOT_TOKEN, channel, THREAD_CLOSED_MESSAGE, {
        thread_ts: threadTs,
      });
      return;
    }
    // An image-only follow-up that lost every image sends no prompt; the
    // user was already told inside deliverPrompt.
    if (promptResult.reason === "no_images_delivered") return;
    if (promptResult.reason === "harness_model_incompatible") {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        formatHarnessModelRefusal(promptResult.message),
        { thread_ts: threadTs }
      );
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
    if (promptResult.reason === "forbidden") {
      await postMessage(env.SLACK_BOT_TOKEN, channel, "you do not have access to this session", {
        thread_ts: threadTs,
      });
      return;
    }
    // Actor-concealed 404s must not disable a thread that remains publishable for the channel.
    if (
      (await checkPublicationAccess(env, existingSession.sessionId, channel, traceId)) === "denied"
    ) {
      log.warn("thread_session.closed", {
        trace_id: traceId,
        session_id: existingSession.sessionId,
        channel,
        thread_ts: threadTs,
      });
      await closeThreadSession(env, channel, threadTs, existingSession.sessionId);
    }
    await postMessage(env.SLACK_BOT_TOKEN, channel, THREAD_CLOSED_MESSAGE, { thread_ts: threadTs });
    return;
  }

  const binding = await resolveChannelBinding(env, channel, threadTs || ts, traceId);
  if (!binding) return;
  const { teamId } = binding;
  let launchSettings: SlackLaunchSettings | undefined;
  let launchPlan: SessionLaunchPlan | undefined;
  if (hasInlineOverrides) {
    const authoritativeLaunchSettings = await loadAuthoritativeSlackLaunchSettings(
      env,
      user,
      traceId
    );
    if (!authoritativeLaunchSettings) {
      await postMessage(env.SLACK_BOT_TOKEN, channel, MODEL_PREFERENCES_UNAVAILABLE_MESSAGE, {
        thread_ts: threadTs || ts,
      });
      return;
    }
    launchSettings = authoritativeLaunchSettings;
    const resolvedTurn = resolveInlinePromptOptions(
      inlinePromptOptions,
      {
        model: launchSettings.userPreferences.model,
        reasoningEffort: launchSettings.userPreferences.reasoningEffort,
      },
      launchSettings.enabledModels
    );
    if (!resolvedTurn.ok) {
      await postMessage(env.SLACK_BOT_TOKEN, channel, resolvedTurn.error, {
        thread_ts: threadTs || ts,
      });
      return;
    }
    launchPlan = { sessionDefaults: resolvedTurn.turnPlan.effective };
    scheduleStartingStatus(scheduleBackground, env, channel, threadTs || ts, traceId);
  }

  const threadHistory = threadTs
    ? await fetchInteractiveThreadContext(
        env,
        channel,
        threadTs,
        { beforeTs: ts, includeBotMessages: true },
        traceId
      )
    : undefined;
  const previousMessages = threadHistory?.messages;

  const result = await createClassifier(env).classify(
    promptText,
    {
      channelId: channel,
      teamId,
      userId: user,
      channelName,
      channelDescription,
      threadTs,
      previousMessages,
    },
    traceId
  );
  if (result.needsClarification || !result.target) {
    const catalog = await loadTargetCatalog(env, traceId, channel, user);
    const clarificationThreadTs = threadTs || ts;
    const requestId = crypto.randomUUID();
    await storePendingRequest(env, {
      requestId,
      teamId,
      channel,
      threadTs: clarificationThreadTs,
      message: requestText,
      userId: user,
      unattributedPrompt: { forwardedMessages: forwarded.entries },
      previousMessages,
      channelName,
      channelDescription,
      imageOnly: imageOnly || undefined,
      messageTs: ts,
      threadContextSource: threadTs ? { threadTs, beforeTs: ts } : undefined,
      // Persist where the images live, not the file objects; they are
      // re-fetched from Slack when the user resolves the clarification.
      sourceMessage: images.length > 0 ? { ts, threadTs } : undefined,
      launchPlan,
      classification: {
        targetId: result.target ? targetId(result.target) : undefined,
        confidence: result.confidence,
        source: result.source,
      },
    });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      `I couldn't determine which target to use. ${result.reasoning}${getTargetCatalogNotice(catalog)}`,
      {
        thread_ts: clarificationThreadTs,
        blocks: buildTargetClarificationBlocks(
          result.reasoning,
          result.target?.kind === "none"
            ? [result.target, ...(result.alternatives ?? [])]
            : result.alternatives,
          catalog,
          requestId
        ),
      }
    );
    return;
  }

  const threadKey = threadTs || ts;
  log.info("target.decision", {
    trace_id: traceId,
    channel,
    thread_ts: threadKey,
    decision_path: "direct",
    classification_source: result.source,
    confidence: result.confidence,
    target_kind: result.target.kind,
    target_id: targetId(result.target),
  });
  const ack = buildWorkingMessage();
  const ackResult = await postMessage(env.SLACK_BOT_TOKEN, channel, ack.text, {
    thread_ts: threadKey,
    blocks: ack.blocks,
  });
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  actor ??= await resolveSlackActorIdentity(env.SLACK_BOT_TOKEN, user);
  const sessionResult = await startSessionAndSendPrompt(env, {
    target: result.target,
    teamId,
    channel,
    threadTs: threadKey,
    messageText: formatAttributedRequest(actor.senderLabel, requestText, forwarded.entries),
    actor,
    messageTs: ts,
    previousMessages,
    channelName,
    channelDescription,
    images,
    contextImages: threadHistory?.images,
    imageOnly,
    launchPlan,
    launchSettings,
    traceId,
  });
  if (!sessionResult) return;
  if (ackTs) {
    const launched = buildWorkingMessage({
      sessionId: sessionResult.sessionId,
      webAppUrl: env.WEB_APP_URL,
      sessionDefaultsNotice: formatSessionDefaultsNotice(sessionResult),
    });
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, launched.text, {
      blocks: launched.blocks,
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}

/**
 * Handle an `app_mention` event: strip the mention, recover the message's
 * files and attachments (mention events never carry files, and may omit the
 * attachments that hold forwarded message bodies), and hand off to the shared
 * message flow.
 */
export async function handleAppMention(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    files?: SlackMessageFile[];
    attachments?: SlackMessageAttachment[];
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  const admission = await resolveThreadSessionAdmission(
    env,
    event.channel,
    event.thread_ts,
    traceId
  );
  if (admission.kind === "stop") return;
  const parsedFlags = parseInlinePromptFlags(stripMentions(event.text));
  const messageText = parsedFlags.ok ? parsedFlags.text : "";
  const threadKey = event.thread_ts || event.ts;
  if (messageText && parsedFlags.ok && !hasInlinePromptOptions(parsedFlags.options))
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);

  // app_mention events don't carry the message's `files` array and may arrive
  // without its `attachments`, so when either is missing we recover the message
  // from conversation history — overlapped with the channel-info fetch to keep
  // the extra round trip off the critical path. Whatever the event did carry
  // wins; the lookup only fills gaps.
  type MessageDetails = { files: SlackMessageFile[]; attachments: SlackMessageAttachment[] };
  const eventDetails: MessageDetails = {
    files: event.files ?? [],
    attachments: event.attachments ?? [],
  };
  const detailsPromise: Promise<MessageDetails> =
    eventDetails.files.length && eventDetails.attachments.length
      ? Promise.resolve(eventDetails)
      : getMessageDetails(env.SLACK_BOT_TOKEN, event.channel, event.ts, event.thread_ts).then(
          (lookup) => {
            if (lookup.ok) {
              return {
                files: eventDetails.files.length ? eventDetails.files : lookup.files,
                attachments: eventDetails.attachments.length
                  ? eventDetails.attachments
                  : lookup.attachments,
              };
            }
            // Failure is not "the message has none": any images and forwarded
            // messages are lost here, so make the drop visible in logs.
            log.warn("slack.attachment.file_lookup_failed", {
              trace_id: traceId,
              channel: event.channel,
              message_ts: event.ts,
              slack_error: lookup.error,
            });
            return eventDetails;
          }
        );
  // Fetched unconditionally: image-only mentions rely on channel context as
  // their main classifier signal, and detailsPromise is awaited anyway.
  const channelInfoPromise = getChannelInfo(env.SLACK_BOT_TOKEN, event.channel).catch(
    () => undefined
  );
  const [details, channelInfo] = await Promise.all([detailsPromise, channelInfoPromise]);
  const forwarded = collectForwardedMessages(details.attachments);
  // A forwarded message's own images are Slack-hosted message files, so they
  // join the message's own images on the single attachment path.
  const images = toImageAttachments([...details.files, ...forwarded.files], traceId);
  const content: IncomingMessageContent = {
    text: messageText,
    images,
    forwarded,
    inlinePromptOptions: parsedFlags.ok ? parsedFlags.options : EMPTY_INLINE_PROMPT_OPTIONS,
    inlineFlagError: parsedFlags.ok ? undefined : parsedFlags.error,
  };
  if (
    parsedFlags.ok &&
    !hasInlinePromptOptions(parsedFlags.options) &&
    !messageText &&
    hasRunnableContent(content)
  ) {
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  }
  let channelName: string | undefined;
  let channelDescription: string | undefined;
  if (channelInfo?.ok && channelInfo.channel) {
    channelName = channelInfo.channel.name;
    channelDescription = channelInfo.channel.topic?.value || channelInfo.channel.purpose?.value;
  }
  await handleIncomingMessage({
    content,
    admission,
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

/** Handle a direct message to the bot, including image-only file_share DMs. */
export async function handleDirectMessage(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    channel_type?: string;
    files?: SlackMessageFile[];
    attachments?: SlackMessageAttachment[];
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  log.info("slack.dm.received", { trace_id: traceId, user: event.user, channel: event.channel });
  const admission = await resolveThreadSessionAdmission(
    env,
    event.channel,
    event.thread_ts,
    traceId
  );
  if (admission.kind === "stop") return;
  const parsedFlags = parseInlinePromptFlags(stripMentions(event.text));
  const messageText = parsedFlags.ok ? parsedFlags.text : "";
  const forwarded = collectForwardedMessages(event.attachments);
  const images = toImageAttachments([...(event.files ?? []), ...forwarded.files], traceId);
  const content: IncomingMessageContent = {
    text: messageText,
    images,
    forwarded,
    inlinePromptOptions: parsedFlags.ok ? parsedFlags.options : EMPTY_INLINE_PROMPT_OPTIONS,
    inlineFlagError: parsedFlags.ok ? undefined : parsedFlags.error,
  };
  const threadKey = event.thread_ts || event.ts;
  if (parsedFlags.ok && !hasInlinePromptOptions(parsedFlags.options) && hasRunnableContent(content))
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  await handleIncomingMessage({
    content,
    admission,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    env,
    traceId,
    scheduleBackground,
  });
}
