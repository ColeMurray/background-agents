import {
  buildSlackContextBlock,
  slackChannelLabel,
  type SlackAutomationEvent,
} from "@open-inspect/shared/triggers";
import type { computeHmacHex } from "@open-inspect/shared/auth";
import { z } from "zod";
import { slackPostGate, type SlackPostScope } from "../authorization/slack-post-gate";
import type { AutomationStore, AutomationRunRow } from "../db/automation-store";
import type { IntegrationSettingsStore } from "../db/integration-settings";
import type { Logger } from "../logger";
import type { FetchClient } from "../platform-ports";
import type { retryDelivery } from "../session/callback-delivery";
import type { AutomationRunCompletion } from "./contracts";
import {
  buildSlackCompletionNotification,
  buildSlackSkipNotification,
  formatRunRepositoryLabel,
  parseSlackTriggerMetadata,
} from "./slack-completion";

export interface AutomationSlackServiceDeps {
  bot?: FetchClient;
  signingSecret?: string;
  automations: Pick<AutomationStore, "getInvocationById" | "getById">;
  settings: Pick<IntegrationSettingsStore, "getGlobal">;
  postScope: SlackPostScope;
  sign: typeof computeHmacHex;
  retryDelivery: typeof retryDelivery;
  sleep(ms: number): Promise<void>;
  clock: Pick<DateConstructor, "now">;
  log: Logger;
}

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

/** Slack context and publication for automation runs; event caches belong to the caller. */
export class AutomationSlackService {
  constructor(private readonly deps: AutomationSlackServiceDeps) {}

  async getSessionInstructions(): Promise<string | undefined> {
    try {
      const instructions = (await this.deps.settings.getGlobal("slack"))?.defaults
        ?.sessionInstructions;
      return typeof instructions === "string" && instructions.trim() ? instructions : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Tell the slack-bot to post a slack-triggered run's result into the triggering
   * message's thread and clear the `eyes` reaction, via its
   * `/callbacks/automation-complete` endpoint. Signs the body with the
   * slack-bot's own service secret (in-body HMAC, matching the bot's other
   * callbacks). No-ops when the run has no triggering message, when
   * `SLACK_BOT` is unbound, or when the secret is unset — all best-effort.
   */
  async notifyCompletion(
    run: AutomationRunRow,
    completion: AutomationRunCompletion
  ): Promise<void> {
    const binding = this.deps.bot;
    const secret = this.deps.signingSecret;
    if (!binding || !secret) return;

    let closureReason: string | null = null;
    await this.deps.retryDelivery<void, Response>(
      async (signal) => {
        const invocation = await this.deps.automations.getInvocationById(run.invocation_id);
        const meta = parseSlackTriggerMetadata(invocation?.trigger_metadata ?? null);
        if (!meta?.messageTs) return { outcome: "delivered", value: undefined };
        const automation = await this.deps.automations.getById(completion.automationId);
        const [session, channelBinding] = await Promise.all([
          this.deps.postScope.getSession(completion.sessionId),
          this.deps.postScope.getChannelBinding(meta.channel),
        ]);
        // D1 reads cannot be canceled; an expired attempt must not reach the wire.
        signal.throwIfAborted();
        const denial = closureReason ?? slackPostGate(session, channelBinding);
        const body = denial
          ? {
              kind: "slack.thread_closed",
              sessionId: completion.sessionId,
              timestamp: this.deps.clock.now(),
              context: { channel: meta.channel, threadTs: meta.messageTs },
            }
          : buildSlackCompletionNotification(meta, {
              sessionId: completion.sessionId,
              messageId: completion.messageId,
              success: completion.success,
              error: completion.error,
              repoFullName: formatRunRepositoryLabel(run),
              model: automation?.model ?? "",
              reasoningEffort: automation?.reasoning_effort ?? undefined,
            });
        if (!body) return { outcome: "delivered", value: undefined };

        if (denial) {
          this.deps.log.info("Slack completion denied by session scope", {
            event: "scheduler.slack_complete_denied",
            run_id: run.id,
            session_id: completion.sessionId,
            reason: denial,
          });
        }

        const signature = await this.deps.sign(JSON.stringify(body), secret);
        signal.throwIfAborted();
        // The bot can tombstone the thread even when closure delivery fails.
        closureReason = denial;
        const endpoint = denial ? "thread_closed" : "automation-complete";
        const response = await binding.fetch(`https://internal/callbacks/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, signature }),
          signal,
        });
        return response.ok
          ? { outcome: "delivered", value: undefined }
          : { outcome: "retryable_failure", failure: response };
      },
      this.deps.sleep,
      ({ attempt, failure: response, error }) => {
        this.deps.log.warn("Slack completion callback failed", {
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
   * display-name resolution; the scheduler only splices the rendered block into
   * the same layout the ingress path used.
   *
   * Every failure path returns the original context block: thread history is an
   * enhancement and must never prevent a run from starting.
   */
  async contextWithThread(event: SlackAutomationEvent): Promise<string> {
    if (!event.threadTs) return event.contextBlock;

    const binding = this.deps.bot;
    const secret = this.deps.signingSecret;
    if (!binding || !secret) return event.contextBlock;

    try {
      const body = {
        channel: event.channelId,
        threadTs: event.threadTs,
        ts: event.ts,
      };
      const signature = await this.deps.sign(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/internal/thread-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
        signal: AbortSignal.timeout(SLACK_THREAD_CONTEXT_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.deps.log.warn("Slack thread context request failed", {
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
      this.deps.log.warn("Slack thread context request threw", {
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
  async notifySkip(event: SlackAutomationEvent): Promise<void> {
    const binding = this.deps.bot;
    const secret = this.deps.signingSecret;
    if (!binding || !secret) return;

    const body = buildSlackSkipNotification({
      channelId: event.channelId,
      actorUserId: event.actorUserId,
      threadTs: event.threadTs,
      ts: event.ts,
    });
    if (!body) return;

    try {
      const signature = await this.deps.sign(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.deps.log.warn("Slack skip callback failed", {
          event: "scheduler.slack_skip_failed",
          channel: event.channelId,
          http_status: response.status,
        });
      }
    } catch (e) {
      this.deps.log.warn("Slack skip callback errored", {
        event: "scheduler.slack_skip_failed",
        channel: event.channelId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }
}
