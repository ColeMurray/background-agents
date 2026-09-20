/** Session-owned event production; hosts deliver accepted jobs independently of this runtime. */
import { sessionCallbackJobSchema } from "@open-inspect/shared/types/session-callback-jobs";
import { SLACK_ACTIVITY_REFRESH_KIND } from "@open-inspect/shared/types/session-api";
import type { Jobs } from "../jobs";
import type { Logger } from "../logger";
import type { MessageRepository } from "./message-repository";
import { retryDelivery } from "./callback-delivery";

export interface CallbackServiceDeps {
  messageRepository: Pick<
    MessageRepository,
    "getMessageCallbackContext" | "getProcessingMessageWithStartedAt"
  >;
  jobs: Jobs;
  log: Logger;
  getSessionId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const NOTIFIED_CALL_IDS_CAP = 500;
const TOOL_CALL_INTERVAL_MS = 3000;
export const SLACK_ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

export class CallbackNotificationService {
  private lastToolCallAt = 0;
  private lastSlackActivityAt = 0;
  private readonly notifiedCallIds = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CallbackServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private context(messageId: string): { source: string | null; context: unknown } | null {
    const message = this.deps.messageRepository.getMessageCallbackContext(messageId);
    if (!message?.callback_context) return null;
    try {
      const context: unknown = JSON.parse(message.callback_context);
      const automation =
        typeof context === "object" &&
        context !== null &&
        "source" in context &&
        context.source === "automation";
      return { source: automation ? "automation" : message.source, context };
    } catch {
      this.deps.log.warn("callback.context_invalid", { message_id: messageId });
      return null;
    }
  }

  /** Durability starts at acceptance, not at the preceding session state transition. */
  private async publish(input: unknown, retry: boolean): Promise<boolean> {
    const parsed = sessionCallbackJobSchema.safeParse(input);
    if (!parsed.success) {
      this.deps.log.warn("callback.job_invalid", { issues: parsed.error.issues });
      return false;
    }
    const job = parsed.data;
    const send = () => this.deps.jobs.send({ kind: "session.callback", payload: job });
    if (retry) {
      const result = await retryDelivery(
        async () => ({ outcome: "delivered", value: await send() }),
        this.sleep,
        ({ attempt }) =>
          this.deps.log.warn("callback.publish_failed", {
            job_type: job.type,
            session_id: job.payload.sessionId,
            attempt,
          }),
        // Queue send cannot be cancelled. Never race a still-running send.
        { attemptTimeoutMs: null }
      );
      return result.outcome === "delivered";
    }
    try {
      await send();
      return true;
    } catch {
      this.deps.log.warn("callback.publish_failed", {
        job_type: job.type,
        session_id: job.payload.sessionId,
      });
      return false;
    }
  }

  async notifyStarted(messageId: string): Promise<void> {
    const message = this.context(messageId);
    if (message?.source !== "linear") return;
    await this.publish(
      {
        version: 1,
        type: "linear.started",
        payload: {
          sessionId: this.deps.getSessionId(),
          messageId,
          timestamp: Date.now(),
          context: message.context,
        },
      },
      true
    );
  }

  async notifyComplete(messageId: string, success: boolean, error?: string): Promise<void> {
    const message = this.context(messageId);
    if (!message) return;
    const destination =
      message.source === "automation"
        ? "automation"
        : message.source === "linear"
          ? "linear"
          : "slack";
    await this.publish(
      {
        version: 1,
        type: `${destination}.completed`,
        payload: {
          sessionId: this.deps.getSessionId(),
          messageId,
          success,
          ...(error !== undefined ? { error } : {}),
          timestamp: Date.now(),
          context: message.context,
        },
      },
      true
    );
  }

  async refreshSlackActivity(messageId: string, now: number): Promise<void> {
    if (now - this.lastSlackActivityAt < SLACK_ACTIVITY_REFRESH_INTERVAL_MS) return;
    const message = this.context(messageId);
    if (
      message?.source !== "slack" ||
      this.deps.messageRepository.getProcessingMessageWithStartedAt()?.id !== messageId
    )
      return;
    const accepted = await this.publish(
      {
        version: 1,
        type: "slack.activity_refresh",
        payload: {
          kind: SLACK_ACTIVITY_REFRESH_KIND,
          sessionId: this.deps.getSessionId(),
          messageId,
          timestamp: now,
          context: message.context,
        },
      },
      false
    );
    if (accepted) this.lastSlackActivityAt = Math.max(this.lastSlackActivityAt, now);
  }

  async notifyToolCall(
    messageId: string,
    event: {
      type: string;
      tool?: string;
      args?: Record<string, unknown>;
      callId?: string;
      call_id?: string;
      status?: string;
    }
  ): Promise<void> {
    const callId = event.callId ?? event.call_id ?? "";
    if (callId && this.notifiedCallIds.has(callId)) return;
    const message = this.context(messageId);
    if (!message || message.source === "automation") return;
    const now = Date.now();
    const job = sessionCallbackJobSchema.safeParse({
      version: 1,
      type: message.source === "linear" ? "linear.tool_call" : "slack.tool_call",
      payload: {
        sessionId: this.deps.getSessionId(),
        tool: event.tool ?? "unknown",
        args: message.source === "linear" ? event.args : (event.args ?? {}),
        callId,
        status: event.status,
        timestamp: now,
        context: message.context,
      },
    });
    // Invalid events must not spend the throttle window.
    if (!job.success || now - this.lastToolCallAt < TOOL_CALL_INTERVAL_MS) return;
    this.lastToolCallAt = now;
    if (!(await this.publish(job.data, false))) return;
    if (callId) {
      this.notifiedCallIds.add(callId);
      if (this.notifiedCallIds.size > NOTIFIED_CALL_IDS_CAP) {
        const oldest = this.notifiedCallIds.values().next().value;
        if (oldest !== undefined) this.notifiedCallIds.delete(oldest);
      }
    }
    if (message.source === "slack")
      this.lastSlackActivityAt = Math.max(this.lastSlackActivityAt, now);
  }
}
