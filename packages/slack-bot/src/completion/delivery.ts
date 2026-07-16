import { postMessage, removeReaction } from "@open-inspect/shared";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { extractAgentResponse } from "./extractor";
import { buildCompletionBlocks, getFallbackText, truncateError } from "./blocks";
import { deliverMediaArtifacts } from "./media-upload";
import type { SlackCompletionJob } from "./job";

const log = createLogger("completion-delivery");

export async function processSlackCompletion(job: SlackCompletionJob, env: Env): Promise<void> {
  const startTime = Date.now();
  const base = {
    trace_id: job.traceId,
    delivery_id: job.deliveryId,
    source: job.source,
    session_id: job.sessionId,
    message_id: job.messageId,
    channel: job.channel,
  };

  try {
    const agentResponse = await extractAgentResponse(
      env,
      job.sessionId,
      job.messageId,
      job.traceId
    );
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
      return;
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
    const postResult = await postMessage(
      env.SLACK_BOT_TOKEN,
      job.channel,
      getFallbackText(agentResponse),
      { thread_ts: job.threadTs, blocks }
    );
    if (!postResult.ok) {
      log.warn("slack.completion.post", {
        ...base,
        outcome: "error",
        slack_error: postResult.error,
        retry_after: postResult.retryAfter,
      });
      // A network error can be ambiguous; replaying the job may duplicate a Slack completion.
      return;
    }

    const mediaArtifacts = agentResponse.mediaArtifacts ?? [];
    if (env.SLACK_MEDIA_DELIVERY_ENABLED === "true" && mediaArtifacts.length > 0) {
      const mediaResult = await deliverMediaArtifacts({
        env,
        sessionId: job.sessionId,
        messageId: job.messageId,
        channel: job.channel,
        threadTs: job.threadTs,
        artifacts: mediaArtifacts,
        traceId: job.traceId,
      });
      const unavailable = mediaResult.failed + mediaResult.omitted;
      if (unavailable > 0) {
        await postMessage(
          env.SLACK_BOT_TOKEN,
          job.channel,
          `${unavailable} media artifact${unavailable === 1 ? " is" : "s are"} available in the session but could not be attached here.`,
          { thread_ts: job.threadTs }
        );
      }
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
  } catch (error) {
    log.error("callback.complete", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
  } finally {
    if (job.reactionMessageTs) {
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
