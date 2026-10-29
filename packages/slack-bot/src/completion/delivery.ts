import { postBlocks, postMessage, removeReaction } from "@open-inspect/shared/slack";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { ProtectedReadError } from "@open-inspect/shared/completion/extractor";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { requirePublicationAccess } from "../sessions/control-plane-client";
import { isThreadSessionClosed } from "../sessions/thread-session-store";
import { buildCompletionBlocks, truncateError } from "./blocks";
import { isCompletionPosted, markCompletionPosted } from "./delivery-ledger";
import { extractAgentResponse } from "./extractor";
import type { SlackCompletionJob } from "./job";
import { deliverMediaArtifacts } from "./media-upload";

const log = createLogger("completion-delivery");

/**
 * Sentinel an agent emits as its entire final message to decline replying in
 * Slack. Recognized only for automation-sourced completions — see
 * {@link shouldDeclineReply}.
 */
export const NO_REPLY_SENTINEL = "NO_REPLY";

/** Tolerates the trailing period a model tends to add to a bare sentinel. */
const NO_REPLY_PATTERN = new RegExp(`^${NO_REPLY_SENTINEL}\\.?$`, "i");

/**
 * Whether a finished run has declined to say anything in Slack.
 *
 * Channel-trigger automations fire on ambient messages, so "this needed nothing
 * from me" is a legitimate outcome — the message turned out to be chatter
 * between humans, or a follow-up addressed to someone else. With no way to
 * express that, the run's reasoning about why it should stay quiet gets posted
 * as a reply, and a triage automation becomes the noise it was meant to triage.
 *
 * Only automation-sourced completions may decline. An interactive session has a
 * user waiting on a visible answer, so it always posts, falling back to
 * "_Agent completed._" when the agent produced no text.
 *
 * A run that produced artifacts always posts too: work that landed outside
 * Slack needs a pointer to it regardless of what the agent wrote.
 */
export function shouldDeclineReply(
  job: Pick<SlackCompletionJob, "source" | "success">,
  response: AgentResponse
): boolean {
  if (job.source !== "automation") return false;
  if (!job.success || !response.success) return false;
  if (response.artifacts.length > 0) return false;
  if ((response.mediaArtifacts ?? []).length > 0) return false;

  const text = response.textContent.trim();
  return text === "" || NO_REPLY_PATTERN.test(text);
}

export type SlackCompletionDeliveryResult =
  | { kind: "ack" }
  /** Preparation failures before any publication attempt permit replay. */
  | { kind: "retry" };

export async function processSlackCompletion(
  job: SlackCompletionJob,
  env: Env
): Promise<SlackCompletionDeliveryResult> {
  const startTime = Date.now();
  const base = {
    trace_id: job.traceId,
    delivery_id: job.deliveryId,
    source: job.source,
    session_id: job.sessionId,
    message_id: job.messageId,
    channel: job.channel,
  };
  let shouldClearReaction = false;
  let publicationAttempted = false;
  let publicationMarker: Promise<void> | undefined;

  // The marker matches the point after which this job acks and is never replayed.
  const markPublication = (): Promise<void> => {
    publicationAttempted = true;
    publicationMarker ??= markCompletionPosted(env, job.deliveryId);
    return publicationMarker;
  };

  const ackPostedDuplicate = async (): Promise<boolean> => {
    // This attempt already owns the marker; a re-check would skip its own reply.
    if (publicationAttempted) return false;
    if (!(await isCompletionPosted(env, job.deliveryId))) return false;
    log.info("slack.completion.duplicate", { ...base, outcome: "skipped" });
    shouldClearReaction = true;
    return true;
  };

  try {
    if (await ackPostedDuplicate()) return { kind: "ack" };
    if (await isThreadSessionClosed(env, job.channel, job.threadTs, job.sessionId))
      return { kind: "ack" };
    const agentResponse = await extractAgentResponse(
      env,
      job.sessionId,
      job.messageId,
      job.channel,
      job.traceId
    );
    if (await isThreadSessionClosed(env, job.channel, job.threadTs, job.sessionId))
      return { kind: "ack" };
    const mediaArtifacts = agentResponse.mediaArtifacts ?? [];
    let unavailableMedia = 0;
    // Complete protected media reads before emitting any completion message or fallback metadata.
    if (mediaArtifacts.length > 0) {
      if (await ackPostedDuplicate()) return { kind: "ack" };
      const mediaResult = await deliverMediaArtifacts({
        env,
        sessionId: job.sessionId,
        messageId: job.messageId,
        channel: job.channel,
        threadTs: job.threadTs,
        artifacts: mediaArtifacts,
        traceId: job.traceId,
        onShareAttempt: () => markPublication(),
      });
      unavailableMedia = mediaResult.failed + mediaResult.omitted;
      if (await isThreadSessionClosed(env, job.channel, job.threadTs, job.sessionId))
        return { kind: "ack" };
    }
    shouldClearReaction = true;
    agentResponse.error = agentResponse.error || job.error;

    if (!agentResponse.textContent && agentResponse.toolCalls.length === 0 && !job.success) {
      const displayError = truncateError(agentResponse.error || "Unknown error", 2000);
      log.error("callback.complete", {
        ...base,
        outcome: "error",
        error_message: "empty_agent_response",
        agent_error: agentResponse.error || "Unknown error",
        duration_ms: Date.now() - startTime,
      });
      if (await ackPostedDuplicate()) return { kind: "ack" };
      await requirePublicationAccess(env, job.sessionId, job.channel, job.traceId);
      await markPublication();
      await postMessage(env.SLACK_BOT_TOKEN, job.channel, `The agent failed: ${displayError}`, {
        thread_ts: job.threadTs,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:x: *Agent failed:* ${displayError}` },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View Session" },
                url: `${env.WEB_APP_URL}/session/${job.sessionId}`,
                action_id: "view_session",
              },
            ],
          },
        ],
      });
      return { kind: "ack" };
    }

    if (shouldDeclineReply(job, agentResponse)) {
      log.info("callback.complete", {
        ...base,
        outcome: "success",
        declined: true,
        agent_success: job.success,
        tool_call_count: agentResponse.toolCalls.length,
        duration_ms: Date.now() - startTime,
      });
      return { kind: "ack" };
    }

    const blocks = buildCompletionBlocks(
      job.sessionId,
      agentResponse,
      {
        source: "slack",
        channel: job.channel,
        threadTs: job.threadTs,
        reactionMessageTs: job.reactionMessageTs,
        ...job.context,
      },
      env.WEB_APP_URL
    );
    // Without top-level text, Slack derives screen-reader text from the blocks.
    if (await ackPostedDuplicate()) return { kind: "ack" };
    await requirePublicationAccess(env, job.sessionId, job.channel, job.traceId);
    await markPublication();
    const postResult = await postBlocks(env.SLACK_BOT_TOKEN, job.channel, blocks, {
      thread_ts: job.threadTs,
    });
    if (!postResult.ok) {
      log.warn("slack.completion.post", {
        ...base,
        outcome: "error",
        slack_error: postResult.error,
        retry_after: postResult.retryAfter,
      });
      return { kind: "ack" };
    }

    if (
      unavailableMedia > 0 &&
      !(await isThreadSessionClosed(env, job.channel, job.threadTs, job.sessionId))
    ) {
      await requirePublicationAccess(env, job.sessionId, job.channel, job.traceId);
      await postMessage(
        env.SLACK_BOT_TOKEN,
        job.channel,
        `${unavailableMedia} media artifact${unavailableMedia === 1 ? " is" : "s are"} available in the session but could not be attached here.`,
        { thread_ts: job.threadTs }
      );
    }

    log.info("callback.complete", {
      ...base,
      outcome: "success",
      agent_success: job.success,
      tool_call_count: agentResponse.toolCalls.length,
      artifact_count: agentResponse.artifacts.length,
      media_artifact_count: mediaArtifacts.length,
      has_text: Boolean(agentResponse.textContent),
      duration_ms: Date.now() - startTime,
    });
    return { kind: "ack" };
  } catch (error) {
    log.error("callback.complete", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    if (!publicationAttempted) shouldClearReaction = false;
    if (publicationMarker) await publicationMarker;
    return {
      kind:
        publicationAttempted || (error instanceof ProtectedReadError && error.kind === "denied")
          ? "ack"
          : "retry",
    };
  } finally {
    if (shouldClearReaction && job.reactionMessageTs) {
      await clearThinkingReaction(env, job.channel, job.reactionMessageTs, job.traceId);
    }
  }
}

async function clearThinkingReaction(
  env: Env,
  channel: string,
  reactionMessageTs: string,
  traceId?: string
): Promise<void> {
  try {
    const reactionResult = await removeReaction(
      env.SLACK_BOT_TOKEN,
      channel,
      reactionMessageTs,
      "eyes"
    );
    if (!reactionResult.ok && reactionResult.error !== "no_reaction") {
      log.warn("slack.reaction.remove", {
        trace_id: traceId,
        channel,
        message_ts: reactionMessageTs,
        reaction: "eyes",
        slack_error: reactionResult.error,
      });
    }
  } catch (error) {
    log.warn("slack.reaction.remove", {
      trace_id: traceId,
      channel,
      message_ts: reactionMessageTs,
      reaction: "eyes",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
