import {
  addReaction,
  escapeMrkdwnText,
  getChannelInfo,
  getMessageDetails,
  getThreadMessages,
  postMessage,
  resolveUserNames,
  updateMessage,
  type CallbackContext,
  type SlackMessageAttachment,
  type SlackMessageFile,
} from "@open-inspect/shared";
import {
  IMAGE_ONLY_PROMPT_TEXT,
  prepareImageAttachments,
  toImageAttachments,
  type SlackImageAttachment,
} from "../attachments";
import { createClassifier } from "../classifier";
import { loadTargetCatalog } from "../classifier/catalog";
import { stripMentions } from "../dm-utils";
import {
  collectForwardedMessages,
  FORWARD_ONLY_PROMPT_TEXT,
  type ForwardedMessages,
} from "../forwarded-messages";
import { createLogger } from "../logger";
import {
  buildWorkingMessageBlocks,
  scheduleStartingStatus,
  type BackgroundTaskScheduler,
} from "../messages/blocks";
import {
  formatChannelContext,
  formatForwardedContext,
  formatInterimThreadContext,
} from "../messages/context";
import { storePendingRequest } from "../pending-requests/pending-request-store";
import { deliverPrompt } from "../sessions/prompt-delivery";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import {
  advanceLastPromptTs,
  clearThreadSession,
  lookupThreadSession,
} from "../sessions/thread-session-store";
import { buildTargetClarificationBlocks } from "../target-clarification";
import { targetLabel } from "../targets";
import type { Env } from "../types";

const log = createLogger("handler");
const THREAD_HISTORY_MESSAGE_LIMIT = 10;

interface ThreadHistoryOptions {
  /** ts of the message currently being handled, excluded from the history. */
  excludeTs: string;
  /** Only include messages posted strictly after this Slack ts. */
  sinceTs?: string;
  includeBotMessages: boolean;
}

/**
 * Collect the last THREAD_HISTORY_MESSAGE_LIMIT relevant thread messages as
 * "[name]: text" lines. getThreadMessages paginates the full window, so the
 * newest messages survive the cap even in long threads. Returns [] when the
 * window holds no relevant messages and undefined when Slack could not be
 * queried — callers use the distinction to decide whether the window was
 * actually considered.
 */
async function fetchThreadHistory(
  env: Env,
  channel: string,
  threadTs: string,
  options: ThreadHistoryOptions
): Promise<string[] | undefined> {
  const { excludeTs, sinceTs, includeBotMessages } = options;
  try {
    const threadResult = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs, sinceTs);
    if (!threadResult.ok || !threadResult.messages) return undefined;
    const relevant = threadResult.messages
      .filter((m) => {
        if (m.ts === excludeTs) return false;
        if (!includeBotMessages && m.bot_id) return false;
        // conversations.replies can still return the parent message when
        // `oldest` is set, so re-check the boundary here.
        if (sinceTs && parseFloat(m.ts) <= parseFloat(sinceTs)) return false;
        return true;
      })
      .slice(-THREAD_HISTORY_MESSAGE_LIMIT);
    if (relevant.length === 0) return [];
    const uniqueUserIds = [...new Set(relevant.map((m) => m.user).filter(Boolean))] as string[];
    const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
    return relevant.map((m) => {
      if (m.bot_id) return `[Bot]: ${m.text}`;
      const name = m.user ? userNames.get(m.user) || m.user : "Unknown";
      return `[${name}]: ${m.text}`;
    });
  } catch {
    // Thread context is best effort.
    return undefined;
  }
}

interface IncomingMessageContent {
  text: string;
  /** Images attached to the Slack message, normalized at event ingress. */
  images: SlackImageAttachment[];
  /** Quoted bodies, provenance, and files recovered from explicit Slack shares. */
  forwarded: ForwardedMessages;
}

function hasRunnableContent(content: IncomingMessageContent): boolean {
  return Boolean(content.text) || content.images.length > 0 || content.forwarded.hasBody;
}

interface IncomingMessageParams {
  content: IncomingMessageContent;
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

/**
 * Route one user message: follow up on the thread's existing session when there
 * is one, otherwise classify the target and launch a new session (or ask for
 * clarification). Image files are forwarded as session attachments, and the
 * bodies of any forwarded Slack messages are quoted into the prompt.
 */
async function handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
  const {
    content,
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
  const { text: messageText, images, forwarded } = content;
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
  const promptText = formatForwardedContext(forwarded.entries) + requestText;

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
      // The session already has its own turns, so only forward the human
      // discussion that happened in the thread since the last prompt.
      const interimMessages = existingSession.lastPromptTs
        ? await fetchThreadHistory(env, channel, threadTs, {
            excludeTs: ts,
            sinceTs: existingSession.lastPromptTs,
            includeBotMessages: false,
          })
        : undefined;
      const interimContext = interimMessages ? formatInterimThreadContext(interimMessages) : "";
      const promptResult = await deliverPrompt(env, {
        sessionId: existingSession.sessionId,
        content: channelContext + interimContext + promptText,
        authorId: `slack:${user}`,
        attachments: await prepareImageAttachments(env, images, traceId),
        imageOnly,
        callbackContext,
        channel,
        threadTs,
        traceId,
      });
      if (promptResult.ok) {
        // Only advance the checkpoint past messages we know were considered.
        // When the interim fetch failed, keeping the old watermark lets the
        // next follow-up retry the window; at worst it re-includes this
        // message's text as interim context.
        const interimFetchFailed = Boolean(existingSession.lastPromptTs) && !interimMessages;
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
      // An image-only follow-up that lost every image sends no prompt; the
      // user was already told inside deliverPrompt.
      if (promptResult.reason === "no_images_delivered") return;
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

  const previousMessages = threadTs
    ? await fetchThreadHistory(env, channel, threadTs, { excludeTs: ts, includeBotMessages: true })
    : undefined;

  const result = await createClassifier(env).classify(
    promptText,
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
      message: promptText,
      userId: user,
      previousMessages,
      channelName,
      channelDescription,
      imageOnly: imageOnly || undefined,
      // Persist where the images live, not the file objects; they are
      // re-fetched from Slack when the user resolves the clarification.
      sourceMessage: images.length > 0 ? { ts, threadTs } : undefined,
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
  const sessionResult = await startSessionAndSendPrompt(env, {
    target: result.target,
    channel,
    threadTs: threadKey,
    messageText: promptText,
    userId: user,
    messageTs: ts,
    previousMessages,
    channelName,
    channelDescription,
    images,
    imageOnly,
    traceId,
  });
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
  const messageText = stripMentions(event.text);
  const threadKey = event.thread_ts || event.ts;
  if (messageText)
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
  const content = { text: messageText, images, forwarded };
  if (!messageText && hasRunnableContent(content)) {
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
  const messageText = stripMentions(event.text);
  const forwarded = collectForwardedMessages(event.attachments);
  const images = toImageAttachments([...(event.files ?? []), ...forwarded.files], traceId);
  const content = { text: messageText, images, forwarded };
  const threadKey = event.thread_ts || event.ts;
  if (hasRunnableContent(content))
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  await handleIncomingMessage({
    content,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    env,
    traceId,
    scheduleBackground,
  });
}
