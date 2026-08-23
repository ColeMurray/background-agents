import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import {
  linearCompletionCallbackPayloadSchema,
  linearToolCallCallbackPayloadSchema,
} from "@open-inspect/shared/types/session-api";
import type { Logger } from "../logger";
import type { AutomationRunCompletion } from "../scheduler/scheduler";
import { deliverWithRetry } from "./callback-delivery";
import type { MessageRepository } from "./message-repository";

export type AutomationRunCompletionHandler = (
  completion: AutomationRunCompletion
) => Promise<Response>;

export interface CallbackServiceDeps {
  messageRepository: MessageRepository;
  jobs: { send: (job: SessionCallbackJob) => Promise<unknown> };
  log: Logger;
  getSessionId: () => string;
  completeAutomationRun?: AutomationRunCompletionHandler;
  sleep?: (ms: number) => Promise<void>;
}

const NOTIFIED_CALL_IDS_CAP = 500;
const TOOL_CALL_THROTTLE_INTERVAL_MS = 3000;
const EMPTY_TOOL_ARGS: Record<string, unknown> = {};

function parseCallbackContext(value: string): Record<string, unknown> | null {
  try {
    const context: unknown = JSON.parse(value);
    return context && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Creates durable callback jobs without depending on a destination or transport. */
export class CallbackNotificationService {
  private readonly messageRepository: MessageRepository;
  private readonly jobs: CallbackServiceDeps["jobs"];
  private readonly log: Logger;
  private readonly getSessionId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly completeAutomationRun: AutomationRunCompletionHandler | undefined;
  private lastToolCallCallbackTs = 0;
  private readonly notifiedCallIds = new Set<string>();

  constructor(deps: CallbackServiceDeps) {
    this.messageRepository = deps.messageRepository;
    this.jobs = deps.jobs;
    this.log = deps.log;
    this.getSessionId = deps.getSessionId;
    this.completeAutomationRun = deps.completeAutomationRun;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private markCallIdNotified(callId: string): void {
    this.notifiedCallIds.add(callId);
    if (this.notifiedCallIds.size > NOTIFIED_CALL_IDS_CAP) {
      const oldest = this.notifiedCallIds.values().next().value;
      if (oldest !== undefined) this.notifiedCallIds.delete(oldest);
    }
  }

  async notifyStarted(messageId: string): Promise<void> {
    const message = this.messageRepository.getMessageCallbackContext(messageId);
    if (!message?.callback_context || message.source !== "linear") {
      this.log.debug("callback.started", {
        message_id: messageId,
        outcome: "skipped",
        skip_reason: message?.callback_context ? "non_linear_source" : "no_callback_context",
      });
      return;
    }

    const context = parseCallbackContext(message.callback_context);
    if (!context) {
      this.log.info("callback.started", {
        message_id: messageId,
        outcome: "skipped",
        skip_reason: "invalid_callback_context",
      });
      return;
    }

    await this.jobs.send({
      version: 1,
      type: "session.started",
      payload: { sessionId: this.getSessionId(), messageId, timestamp: Date.now(), context },
    });
  }

  async notifyComplete(messageId: string, success: boolean, error?: string): Promise<void> {
    const startedAt = Date.now();
    let sessionId: string | null = null;
    let source: string | null = null;
    let outcome = "rejected";
    let rejectReason = "no_callback_context";
    let thrownError: unknown;

    try {
      sessionId = this.getSessionId();
      const message = this.messageRepository.getMessageCallbackContext(messageId);
      if (!message?.callback_context) return;

      const context = parseCallbackContext(message.callback_context);
      if (!context) {
        rejectReason = "invalid_callback_context";
        return;
      }
      source = context.source === "automation" ? "automation" : (message.source ?? null);
      if (source === "automation") {
        const result = await this.notifyAutomationComplete(
          context as { automationId: string; runId: string; automationName: string },
          success,
          error,
          messageId
        );
        const automationRejectReason = "rejectReason" in result ? result.rejectReason : undefined;
        outcome = result.delivered ? "success" : automationRejectReason ? "rejected" : "error";
        rejectReason = automationRejectReason ?? "";
        return;
      }

      const callbackData = {
        sessionId,
        messageId,
        success,
        ...(error != null ? { error } : {}),
        timestamp: Date.now(),
        context,
      };
      if (
        source === "linear" &&
        !linearCompletionCallbackPayloadSchema.safeParse(callbackData).success
      ) {
        rejectReason = "invalid_payload";
        return;
      }

      await this.jobs.send({
        version: 1,
        type: "session.completed",
        payload: {
          sessionId,
          messageId,
          source,
          success,
          ...(error != null ? { error } : {}),
          timestamp: callbackData.timestamp,
          context,
        },
      });
      outcome = "success";
      rejectReason = "";
    } catch (errorCaught) {
      outcome = "error";
      thrownError = errorCaught;
    } finally {
      const fields = {
        session_id: sessionId,
        message_id: messageId,
        source,
        outcome,
        duration_ms: Date.now() - startedAt,
        ...(rejectReason && thrownError === undefined ? { reject_reason: rejectReason } : {}),
        ...(thrownError !== undefined
          ? { error: thrownError instanceof Error ? thrownError : new Error(String(thrownError)) }
          : {}),
      };
      if (outcome === "error") this.log.error("callback.complete_enqueue", fields);
      else this.log.info("callback.complete_enqueue", fields);
    }
  }

  private async notifyAutomationComplete(
    context: { automationId: string; runId: string; automationName: string },
    success: boolean,
    error: string | undefined,
    messageId: string
  ) {
    if (!this.completeAutomationRun) {
      return { delivered: false, attempts: 0, rejectReason: "no_binding" };
    }

    const payload = {
      automationId: context.automationId,
      runId: context.runId,
      sessionId: this.getSessionId(),
      messageId,
      success,
      error,
      automationName: context.automationName,
    };

    return deliverWithRetry(
      () => this.completeAutomationRun!(payload),
      this.sleep,
      ({ attempt, response, error: deliveryError }) => {
        this.log.warn("callback.complete_delivery_attempt_failed", {
          message_id: messageId,
          session_id: this.getSessionId(),
          source: "automation",
          automation_id: context.automationId,
          run_id: context.runId,
          attempt,
          ...(response ? { http_status: response.status } : {}),
          ...(deliveryError !== undefined
            ? { error: deliveryError instanceof Error ? deliveryError : String(deliveryError) }
            : {}),
        });
      },
      { attemptTimeoutMs: null }
    );
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

    const now = Date.now();
    const tool = event.tool ?? "unknown";
    const message = this.messageRepository.getMessageCallbackContext(messageId);
    if (!message?.callback_context) {
      this.log.debug("callback.tool_call", {
        message_id: messageId,
        tool,
        outcome: "skipped",
        skip_reason: "no_callback_context",
      });
      return;
    }

    const source = message.source ?? null;
    if (source === "automation") {
      this.log.debug("callback.tool_call", {
        message_id: messageId,
        source,
        tool,
        outcome: "skipped",
        skip_reason: "automation_no_consumer",
      });
      return;
    }

    const context = parseCallbackContext(message.callback_context);
    if (!context) {
      this.log.warn("callback.tool_call", {
        message_id: messageId,
        source,
        tool,
        outcome: "skipped",
        skip_reason: "invalid_callback_context",
      });
      return;
    }

    const sessionId = this.getSessionId();
    const args = source === "linear" ? event.args : (event.args ?? EMPTY_TOOL_ARGS);
    const callbackData = {
      sessionId,
      tool,
      args,
      callId,
      status: event.status,
      timestamp: now,
      context,
    };
    if (
      source === "linear" &&
      !linearToolCallCallbackPayloadSchema.safeParse(callbackData).success
    ) {
      this.log.warn("callback.tool_call", {
        message_id: messageId,
        session_id: sessionId,
        source,
        tool,
        outcome: "skipped",
        skip_reason: "invalid_payload",
      });
      return;
    }
    if (now - this.lastToolCallCallbackTs < TOOL_CALL_THROTTLE_INTERVAL_MS) return;

    try {
      await this.jobs.send({
        version: 1,
        type: "tool_call",
        payload: {
          sessionId,
          messageId,
          source,
          tool,
          args: args ?? EMPTY_TOOL_ARGS,
          callId,
          ...(event.status !== undefined ? { status: event.status } : {}),
          timestamp: now,
          context,
        },
      });
      this.lastToolCallCallbackTs = now;
      if (callId) this.markCallIdNotified(callId);
      this.log.info("callback.tool_call_enqueue", {
        message_id: messageId,
        session_id: sessionId,
        source,
        tool,
        outcome: "success",
        duration_ms: Date.now() - now,
      });
    } catch (errorCaught) {
      this.log.warn("callback.tool_call_enqueue", {
        message_id: messageId,
        session_id: sessionId,
        source,
        tool,
        outcome: "error",
        error: errorCaught instanceof Error ? errorCaught : new Error(String(errorCaught)),
        duration_ms: Date.now() - now,
      });
    }
  }
}
