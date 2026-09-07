import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  buildSlackContextBlock,
  slackChannelLabel,
  type SlackAutomationEvent,
} from "@open-inspect/shared/triggers";
import { z } from "zod";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import type { Logger } from "../logger";
import { deliverWithRetry } from "../session/callback-delivery";
import type { Env } from "../types";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  type SlackRunMetadata,
  type SlackCompletionContext,
} from "./slack-completion";

/**
 * Bound on the thread-context request. It sits between admission and launch, so
 * a slow Slack read would hold every child in `starting` until the orphan sweep
 * repairs them. Matches the callback-delivery attempt timeout; on expiry the run
 * launches with no thread history, which is the same fallback as any other
 * failure.
 */
const SLACK_THREAD_CONTEXT_TIMEOUT_MS = 10_000;

const slackThreadContextResponseSchema = z.object({
  threadContext: z.string(),
});

export class SlackDelivery {
  constructor(
    private readonly env: Pick<Env, "SLACK_BOT" | "SERVICE_AUTH_SECRET_SLACK_BOT">,
    private readonly log: Logger
  ) {}

  /**
   * Tell the slack-bot to post a slack-triggered run's result into the triggering
   * message's thread and clear the `eyes` reaction, via its
   * `/callbacks/automation-complete` endpoint. Signs the body with the
   * slack-bot's own service secret (in-body HMAC, matching the bot's other
   * callbacks). No-ops when the run has no triggering message, when
   * `SLACK_BOT` is unbound, or when the secret is unset - all best-effort.
   */
  async notifySlackCompletion(
    run: { automation_id: string; id: string },
    meta: SlackRunMetadata,
    ctx: SlackCompletionContext
  ): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = callbackSigningSecret(this.env, "slack-bot");
    if (!binding || !secret) return;

    const body = buildSlackCompletionNotification(meta, ctx);
    if (!body) return;

    const signature = await computeHmacHex(JSON.stringify(body), secret);
    await deliverWithRetry(
      (signal) =>
        binding.fetch("https://internal/callbacks/automation-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, signature }),
          signal,
        }),
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ({ attempt, response, error }) => {
        this.log.warn("Slack completion callback failed", {
          event: "scheduler.slack_complete_failed",
          automation_id: run.automation_id,
          run_id: run.id,
          attempt,
          ...(response ? { http_status: response.status } : {}),
          ...(error !== undefined
            ? { error: error instanceof Error ? error : new Error(String(error)) }
            : {}),
        });
      }
    );
  }

  /**
   * Rebuild a Slack event's context block with the thread the message was posted
   * in, asking slack-bot to fetch and render it.
   *
   * Called only after an invocation has been admitted, so the read is paid for
   * exactly when a run will consume it. The bot owns the Slack token and
   * display-name resolution; SlackDelivery only splices the rendered block into
   * the same layout the ingress path used.
   *
   * Every failure path returns the original context block: thread history is an
   * enhancement and must never prevent a run from starting.
   */
  async buildSlackContextWithThread(event: SlackAutomationEvent): Promise<string> {
    if (!event.threadTs) return event.contextBlock;

    const binding = this.env.SLACK_BOT;
    const secret = callbackSigningSecret(this.env, "slack-bot");
    if (!binding || !secret) return event.contextBlock;

    try {
      const body = {
        channel: event.channelId,
        threadTs: event.threadTs,
        ts: event.ts,
      };
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/internal/thread-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
        signal: AbortSignal.timeout(SLACK_THREAD_CONTEXT_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.log.warn("Slack thread context request failed", {
          event: "scheduler.slack_thread_context_failed",
          channel: event.channelId,
          http_status: response.status,
        });
        return event.contextBlock;
      }

      const parsed = slackThreadContextResponseSchema.safeParse(await response.json());
      const threadContext = parsed.success ? parsed.data.threadContext : "";
      if (!threadContext) return event.contextBlock;

      return buildSlackContextBlock({
        channelLabel: slackChannelLabel(event.channelId, event.channelName),
        actorUserId: event.actorUserId,
        permalink: event.permalink,
        text: event.text,
        threadContext,
      });
    } catch (error) {
      this.log.warn("Slack thread context request threw", {
        event: "scheduler.slack_thread_context_failed",
        channel: event.channelId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return event.contextBlock;
    }
  }

  /**
   * Post a best-effort ephemeral "a run is already active for this thread"
   * notice to the message author when a slack event is dropped by the
   * per-thread concurrency guard. No-ops without a binding/secret/actor.
   */
  async notifySlackConcurrencySkip(event: SlackAutomationEvent): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = callbackSigningSecret(this.env, "slack-bot");
    if (!binding || !secret) return;

    const body = buildSlackSkipNotification({
      channelId: event.channelId,
      actorUserId: event.actorUserId,
      threadTs: event.threadTs,
      ts: event.ts,
    });
    if (!body) return;

    try {
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.log.warn("Slack skip callback failed", {
          event: "scheduler.slack_skip_failed",
          channel: event.channelId,
          http_status: response.status,
        });
      }
    } catch (e) {
      this.log.warn("Slack skip callback errored", {
        event: "scheduler.slack_skip_failed",
        channel: event.channelId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }
}
