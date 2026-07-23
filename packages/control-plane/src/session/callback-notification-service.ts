/**
 * CallbackNotificationService - Slack/Linear bot callback notifications.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Notifying originating clients (Slack, Linear) on execution completion
 * - Throttled tool-call progress callbacks
 * - HMAC payload signing for callback authentication
 */

import { computeHmacHex } from "@open-inspect/shared";
import { callbackSigningSecret, type CallbackDestination } from "../auth/callback-signing";
import type { Logger } from "../logger";
import { deliverWithRetry } from "./callback-delivery";
import { notifyLinearStarted } from "./linear-start-callback";
import type { SessionRow } from "./types";

/**
 * Narrow repository interface — only the methods CallbackNotificationService needs.
 */
export interface CallbackRepository {
  getMessageCallbackContext(
    messageId: string
  ): { callback_context: string | null; source: string | null } | null;
  getSession(): SessionRow | null;
}

/**
 * Narrow env interface — only the bindings CallbackNotificationService needs.
 */
export interface CallbackServiceEnv {
  // Destination-bot signing keys for callback bodies; the CP
  // holds every bot's key as verifier and signs callbacks with the
  // destination's own.
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_LINEAR_BOT?: string;
  SLACK_BOT?: Fetcher;
  LINEAR_BOT?: Fetcher;
  SCHEDULER_CALLBACK?: Fetcher;
}

/**
 * Dependencies injected into CallbackNotificationService.
 */
export interface CallbackServiceDeps {
  repository: CallbackRepository;
  env: CallbackServiceEnv;
  log: Logger;
  getSessionId: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Per-session cap on remembered tool callIds. Used to dedupe notifications
 * across provider lifecycles (Anthropic emits running+completed, OpenAI may
 * emit only completed). FIFO eviction; the failure mode on overflow is a
 * single duplicate Linear/Slack activity, not data loss.
 */
const NOTIFIED_CALL_IDS_CAP = 500;

interface CallbackDeliveryResult {
  delivered: boolean;
  attempts: number;
  httpStatus?: number;
  rejectReason?: string;
}

export class CallbackNotificationService {
  private readonly repository: CallbackRepository;
  private readonly env: CallbackServiceEnv;
  private readonly log: Logger;
  private readonly getSessionId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private _lastToolCallCallbackTs = 0;
  private readonly notifiedCallIds = new Set<string>();

  constructor(deps: CallbackServiceDeps) {
    this.repository = deps.repository;
    this.env = deps.env;
    this.log = deps.log;
    this.getSessionId = deps.getSessionId;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private markCallIdNotified(callId: string): void {
    this.notifiedCallIds.add(callId);
    if (this.notifiedCallIds.size > NOTIFIED_CALL_IDS_CAP) {
      const oldest = this.notifiedCallIds.values().next().value;
      if (oldest !== undefined) this.notifiedCallIds.delete(oldest);
    }
  }

  /**
   * Generate HMAC signature for callback payload.
   */
  private async signPayload(data: object, secret: string): Promise<string> {
    return computeHmacHex(JSON.stringify(data), secret);
  }

  /**
   * Where a non-automation callback goes and which key signs it — one
   * decision, so destination and signing key cannot diverge (the CP signs
   * with the DESTINATION bot's secret). Automation callbacks
   * are routed to the SchedulerDO before this is consulted. Non-linear
   * sources default to the slack bot for backward compatibility (web
   * sources, etc.).
   */
  private resolveCallbackRoute(source: string | null): {
    binding: Fetcher | undefined;
    secret: string | undefined;
  } {
    const destination: CallbackDestination = source === "linear" ? "linear-bot" : "slack-bot";
    return {
      binding: destination === "linear-bot" ? this.env.LINEAR_BOT : this.env.SLACK_BOT,
      secret: callbackSigningSecret(this.env, destination),
    };
  }

  /** Notify the Linear worker after a Linear message is dispatched to a live sandbox. */
  async notifyStarted(messageId: string): Promise<void> {
    const message = this.repository.getMessageCallbackContext(messageId);
    if (!message?.callback_context || message.source !== "linear") {
      this.log.debug("callback.started", {
        message_id: messageId,
        outcome: "skipped",
        skip_reason: message?.callback_context ? "non_linear_source" : "no_callback_context",
      });
      return;
    }

    const { binding, secret } = this.resolveCallbackRoute("linear");
    if (!secret) {
      this.log.debug("callback.started", {
        message_id: messageId,
        outcome: "skipped",
        skip_reason: "no_secret",
      });
      return;
    }
    if (!binding) {
      this.log.debug("callback.started", {
        message_id: messageId,
        outcome: "skipped",
        skip_reason: "no_binding",
      });
      return;
    }

    await notifyLinearStarted({
      messageId,
      callbackContext: message.callback_context,
      sessionId: this.getSessionId(),
      secret,
      binding,
      log: this.log,
      sleep: this.sleep,
    });
  }

  /**
   * Notify the originating client of completion with retry.
   * Routes to the correct service binding based on the message source.
   */
  async notifyComplete(messageId: string, success: boolean, error?: string): Promise<void> {
    const sessionId = this.getSessionId();
    const startedAt = Date.now();
    let source: string | null = null;
    let result: CallbackDeliveryResult = {
      delivered: false,
      attempts: 0,
      rejectReason: "unexpected_error",
    };
    let thrownError: unknown;

    try {
      const message = this.repository.getMessageCallbackContext(messageId);
      if (!message?.callback_context) {
        result.rejectReason = "no_callback_context";
        return;
      }

      const context = JSON.parse(message.callback_context);
      source = context.source === "automation" ? "automation" : (message.source ?? null);

      // Route automation callbacks to SchedulerDO (different URL + payload).
      if (source === "automation") {
        result = await this.notifyAutomationComplete(context, success, error, messageId);
        return;
      }

      const { binding, secret } = this.resolveCallbackRoute(source);
      if (!secret) {
        result.rejectReason = "no_secret";
        return;
      }
      if (!binding) {
        result.rejectReason = "no_binding";
        return;
      }

      const timestamp = Date.now();
      const payloadData = {
        sessionId,
        messageId,
        success,
        ...(error != null ? { error } : {}),
        timestamp,
        context,
      };
      const signature = await this.signPayload(payloadData, secret);
      const payload = { ...payloadData, signature };
      result = await deliverWithRetry(
        (signal) =>
          binding.fetch("https://internal/callbacks/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          }),
        this.sleep,
        ({ attempt, response, error: deliveryError }) => {
          this.log.warn("callback.complete_delivery_attempt_failed", {
            message_id: messageId,
            session_id: sessionId,
            source,
            attempt,
            ...(response ? { http_status: response.status } : {}),
            ...(deliveryError !== undefined
              ? { error: deliveryError instanceof Error ? deliveryError : String(deliveryError) }
              : {}),
          });
        }
      );
    } catch (caught) {
      thrownError = caught;
      throw caught;
    } finally {
      const outcome =
        thrownError !== undefined
          ? "error"
          : result.rejectReason
            ? "rejected"
            : result.delivered
              ? "success"
              : "error";
      const fields = {
        session_id: sessionId,
        message_id: messageId,
        source,
        outcome,
        duration_ms: Date.now() - startedAt,
        attempts: result.attempts,
        retries: Math.max(0, result.attempts - 1),
        ...(result.httpStatus !== undefined ? { http_status: result.httpStatus } : {}),
        ...(result.rejectReason && thrownError === undefined
          ? { reject_reason: result.rejectReason }
          : {}),
        ...(thrownError !== undefined
          ? { error: thrownError instanceof Error ? thrownError : new Error(String(thrownError)) }
          : {}),
      };
      if (outcome === "error") this.log.error("callback.complete_delivery", fields);
      else this.log.info("callback.complete_delivery", fields);
    }
  }

  /**
   * Notify the SchedulerDO of automation run completion.
   * Uses a different URL and payload shape than bot callbacks.
   */
  private async notifyAutomationComplete(
    context: { automationId: string; runId: string; automationName: string },
    success: boolean,
    error: string | undefined,
    messageId: string
  ): Promise<CallbackDeliveryResult> {
    const binding = this.env.SCHEDULER_CALLBACK;
    if (!binding) {
      return { delivered: false, attempts: 0, rejectReason: "no_binding" };
    }

    const payload = {
      automationId: context.automationId,
      runId: context.runId,
      sessionId: this.getSessionId(),
      // The message whose agent response the bot fetches to post the run result.
      messageId,
      success,
      error,
      automationName: context.automationName,
    };

    return deliverWithRetry(
      (signal) =>
        binding.fetch("https://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        }),
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
      }
    );
  }

  /**
   * Notify the originating client of a tool_call event (best-effort, throttled).
   * Max 1 callback per 3 seconds per session.
   */
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

    // Dedup before throttle so a skipped duplicate doesn't burn the rate-limit
    // window. Anthropic emits running+completed for the same callId; OpenAI's
    // Responses API may emit only completed. Fire once per successfully
    // delivered callId either way — failed deliveries do not mark the set, so
    // a later event for the same callId can retry.
    if (callId && this.notifiedCallIds.has(callId)) return;

    // Throttle: max 1 per 3 seconds
    const now = Date.now();
    if (now - this._lastToolCallCallbackTs < 3000) return;
    this._lastToolCallCallbackTs = now;

    const tool = event.tool ?? "unknown";

    const message = this.repository.getMessageCallbackContext(messageId);
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

    // Automation runs have no tool-call progress consumer: the SchedulerDO
    // only implements /internal/run-complete — every /callbacks/tool_call
    // forward 404s. Skip rather than spam best-effort calls.
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

    const { binding, secret } = this.resolveCallbackRoute(source);
    if (!secret) {
      this.log.debug("callback.tool_call", {
        message_id: messageId,
        tool,
        outcome: "skipped",
        skip_reason: "no_secret",
      });
      return;
    }
    if (!binding) {
      this.log.debug("callback.tool_call", {
        message_id: messageId,
        source,
        tool,
        outcome: "skipped",
        skip_reason: "no_binding",
      });
      return;
    }

    const sessionId = this.getSessionId();
    const context = JSON.parse(message.callback_context);

    const payloadData = {
      sessionId,
      tool,
      args: event.args ?? {},
      callId,
      status: event.status,
      timestamp: now,
      context,
    };

    const signature = await this.signPayload(payloadData, secret);
    const payload = { ...payloadData, signature };

    try {
      const response = await binding.fetch("https://internal/callbacks/tool_call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        // Mark only on success so a transient failure doesn't dedupe the next
        // event for this callId (Anthropic's running and completed may be
        // seconds apart for long-running tools — the second event should retry).
        if (callId) this.markCallIdNotified(callId);
        this.log.info("callback.tool_call", {
          message_id: messageId,
          session_id: sessionId,
          source,
          tool,
          outcome: "success",
          http_status: response.status,
          duration_ms: Date.now() - now,
        });
      } else {
        const responseText = await response.text().catch(() => "");
        this.log.warn("callback.tool_call", {
          message_id: messageId,
          session_id: sessionId,
          source,
          tool,
          outcome: "error",
          http_status: response.status,
          response_body: responseText.slice(0, 500),
          duration_ms: Date.now() - now,
        });
      }
    } catch (e) {
      this.log.warn("callback.tool_call", {
        message_id: messageId,
        session_id: sessionId,
        source,
        tool,
        outcome: "error",
        error: e instanceof Error ? e : new Error(String(e)),
        duration_ms: Date.now() - now,
      });
    }
  }
}
