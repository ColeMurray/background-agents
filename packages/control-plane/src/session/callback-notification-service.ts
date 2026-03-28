/**
 * CallbackNotificationService - Slack/Linear bot callback notifications.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Notifying originating clients (Slack, Linear) on execution completion
 * - Throttled tool-call progress callbacks
 * - HMAC payload signing for callback authentication
 */

import { computeHmacHex } from "@open-inspect/shared";
import type { Logger } from "../logger";
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
  INTERNAL_CALLBACK_SECRET?: string;
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
}

export class CallbackNotificationService {
  private readonly repository: CallbackRepository;
  private readonly env: CallbackServiceEnv;
  private readonly log: Logger;
  private readonly getSessionId: () => string;
  private _lastToolCallCallbackTs = 0;

  constructor(deps: CallbackServiceDeps) {
    this.repository = deps.repository;
    this.env = deps.env;
    this.log = deps.log;
    this.getSessionId = deps.getSessionId;
  }

  /**
   * Generate HMAC signature for callback payload.
   */
  private async signPayload(data: object, secret: string): Promise<string> {
    return computeHmacHex(JSON.stringify(data), secret);
  }

  /**
   * Resolve the callback service binding based on the message source.
   * Returns the appropriate Fetcher for the originating client.
   */
  private getBinding(source: string | null): Fetcher | undefined {
    switch (source) {
      case "automation":
        return this.env.SCHEDULER_CALLBACK;
      case "linear":
        return this.env.LINEAR_BOT;
      case "slack":
        return this.env.SLACK_BOT;
      default:
        // Default to SLACK_BOT for backward compatibility (web sources, etc.)
        return this.env.SLACK_BOT;
    }
  }

  /**
   * Notify the originating client of completion with retry.
   * Routes to the correct service binding based on the message source.
   */
  async notifyComplete(messageId: string, success: boolean, error?: string): Promise<void> {
    // Safely query for callback context
    const message = this.repository.getMessageCallbackContext(messageId);
    if (!message?.callback_context) {
      this.log.debug("No callback context for message, skipping notification", {
        message_id: messageId,
      });
      return;
    }

    const context = JSON.parse(message.callback_context);

    // Route automation callbacks to SchedulerDO (different URL + payload)
    if (context.source === "automation") {
      return this.notifyAutomationComplete(context, success, error);
    }

    if (!this.env.INTERNAL_CALLBACK_SECRET) {
      this.log.debug("INTERNAL_CALLBACK_SECRET not configured, skipping notification");
      return;
    }

    // Resolve the callback binding based on message source
    const source = message.source ?? null;
    const binding = this.getBinding(source);
    if (!binding) {
      this.log.debug("No callback binding for source, skipping notification", {
        message_id: messageId,
        source,
      });
      return;
    }

    const sessionId = this.getSessionId();
    const timestamp = Date.now();

    // Build payload without signature
    const payloadData = {
      sessionId,
      messageId,
      success,
      timestamp,
      context,
    };

    // Sign the payload
    const signature = await this.signPayload(payloadData, this.env.INTERNAL_CALLBACK_SECRET);

    const payload = { ...payloadData, signature };

    // Try with retry (max 2 attempts)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await binding.fetch("https://internal/callbacks/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          this.log.info("Callback succeeded", { message_id: messageId, source });
          return;
        }

        const responseText = await response.text();
        this.log.error("Callback failed", {
          message_id: messageId,
          source,
          status: response.status,
          response_text: responseText,
        });
      } catch (e) {
        this.log.error("Callback attempt failed", {
          message_id: messageId,
          source,
          attempt: attempt + 1,
          error: e instanceof Error ? e : String(e),
        });
      }

      // Wait before retry
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    this.log.error("Failed to notify callback client after retries", {
      message_id: messageId,
      source,
    });
  }

  /**
   * Notify the SchedulerDO of automation run completion.
   * Uses a different URL and payload shape than bot callbacks.
   */
  private async notifyAutomationComplete(
    context: { automationId: string; runId: string; automationName: string },
    success: boolean,
    error?: string
  ): Promise<void> {
    const binding = this.env.SCHEDULER_CALLBACK;
    if (!binding) {
      this.log.warn("No SCHEDULER_CALLBACK binding, skipping automation notification");
      return;
    }

    const payload = {
      automationId: context.automationId,
      runId: context.runId,
      sessionId: this.getSessionId(),
      success,
      error,
      automationName: context.automationName,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await binding.fetch("https://internal/internal/run-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.ok) {
          this.log.info("Automation callback succeeded", {
            automation_id: context.automationId,
            run_id: context.runId,
          });
          return;
        }
        const text = await response.text().catch(() => "");
        this.log.error("Automation callback failed", {
          automation_id: context.automationId,
          run_id: context.runId,
          status: response.status,
          response_text: text.slice(0, 500),
        });
      } catch (e) {
        this.log.error("Automation callback attempt failed", {
          automation_id: context.automationId,
          run_id: context.runId,
          attempt: attempt + 1,
          error: e instanceof Error ? e : String(e),
        });
      }
      if (attempt < 1) await new Promise((r) => setTimeout(r, 1000));
    }

    this.log.error("Failed to notify scheduler after retries", {
      automation_id: context.automationId,
      run_id: context.runId,
    });
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
      call_id?: string;
      status?: string;
    }
  ): Promise<void> {
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
    if (!this.env.INTERNAL_CALLBACK_SECRET) {
      this.log.debug("callback.tool_call", {
        message_id: messageId,
        tool,
        outcome: "skipped",
        skip_reason: "no_secret",
      });
      return;
    }

    const source = message.source ?? null;
    const binding = this.getBinding(source);
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
      callId: event.call_id ?? "",
      status: event.status,
      timestamp: now,
      context,
    };

    const signature = await this.signPayload(payloadData, this.env.INTERNAL_CALLBACK_SECRET);
    const payload = { ...payloadData, signature };

    try {
      const response = await binding.fetch("https://internal/callbacks/tool_call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
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
