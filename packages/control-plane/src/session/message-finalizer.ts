import type { Logger } from "../logger";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SessionMessenger } from "./messenger";
import type { SessionRepository } from "./repository";
import type { SessionTerminalMessageProjection } from "./terminal-message-projection";

type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

export interface FinalizableSessionMessage {
  id: string;
  createdAt: number;
}

/** Persists and publishes one message's canonical terminal event. */
export interface SessionMessageFinalizer {
  /** Awaits terminal projection before publishing the sandbox-supplied event. */
  finalizeSandboxCompletion(event: ExecutionCompleteEvent, completedAt: number): Promise<void>;
  /** Synchronously persists a synthetic failure; projections continue in waitUntil. */
  finalizeSyntheticFailure(
    message: FinalizableSessionMessage,
    error: string,
    completedAt: number
  ): void;
}

export class SessionMessageFinalizerService implements SessionMessageFinalizer {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly messenger: SessionMessenger,
    private readonly terminalMessageProjection: SessionTerminalMessageProjection
  ) {}

  async finalizeSandboxCompletion(
    event: ExecutionCompleteEvent,
    completedAt: number
  ): Promise<void> {
    const messageId = event.messageId;
    this.repository.upsertExecutionCompleteEvent(messageId, event, completedAt);
    const status = event.success ? "completed" : "failed";
    this.repository.updateMessageCompletion(
      messageId,
      status,
      completedAt,
      event.success ? null : (event.error ?? null)
    );

    const timestamps = this.repository.getMessageTimestamps(messageId);
    if (timestamps) {
      // The sandbox caller snapshots and drains the queue after this returns;
      // synthetic stop/timeout projections have no such tail and stay in waitUntil.
      await this.terminalMessageProjection.recordTerminalMessage({
        messageId,
        messageCreatedAt: timestamps.created_at,
        terminalMessageCompletedAt: completedAt,
      });
    }
    const totalDurationMs = timestamps ? completedAt - timestamps.created_at : undefined;
    const processingDurationMs =
      timestamps?.started_at != null ? completedAt - timestamps.started_at : undefined;
    const queueDurationMs =
      timestamps?.started_at != null ? timestamps.started_at - timestamps.created_at : undefined;

    this.log.info("prompt.complete", {
      event: "prompt.complete",
      message_id: messageId,
      outcome: event.success ? "success" : "failure",
      message_status: status,
      total_duration_ms: totalDurationMs,
      processing_duration_ms: processingDurationMs,
      queue_duration_ms: queueDurationMs,
    });

    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  finalizeSyntheticFailure(
    message: FinalizableSessionMessage,
    error: string,
    completedAt: number
  ): void {
    this.repository.updateMessageCompletion(message.id, "failed", completedAt, error);
    const event: ExecutionCompleteEvent = {
      type: "execution_complete",
      messageId: message.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(message.id, event, completedAt);
    this.ctx.waitUntil(
      this.terminalMessageProjection.recordTerminalMessage({
        messageId: message.id,
        messageCreatedAt: message.createdAt,
        terminalMessageCompletedAt: completedAt,
      })
    );
    this.messenger.broadcast({ type: "sandbox_event", event });
  }
}
