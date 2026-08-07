import type { Logger } from "../logger";
import type { SandboxEvent } from "../types";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionMessenger } from "./messenger";
import type { SessionRepository } from "./repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionTerminalMessageProjection } from "./terminal-message-projection";

type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

export interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
}

export interface SessionExecutionCompletion {
  completeFromSandbox(
    event: ExecutionCompleteEvent,
    messageId: string | null,
    processingMessageId: string | null,
    completedAt: number
  ): Promise<void>;
  stopProcessingMessage(options?: StopExecutionOptions): Promise<void>;
  failStuckProcessingMessage(): Promise<void>;
}

export class SessionExecutionCompletionService implements SessionExecutionCompletion {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly messenger: SessionMessenger,
    private readonly statusService: SessionStatusService,
    private readonly terminalMessageProjection: SessionTerminalMessageProjection,
    private readonly now: () => number = () => Date.now()
  ) {}

  async completeFromSandbox(
    event: ExecutionCompleteEvent,
    messageId: string | null,
    processingMessageId: string | null,
    completedAt: number
  ): Promise<void> {
    if (messageId == null || processingMessageId !== messageId) {
      this.log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: messageId,
        outcome: "already_stopped",
      });
      return;
    }

    this.repository.upsertExecutionCompleteEvent(messageId, event, completedAt);
    const status = event.success ? "completed" : "failed";
    this.repository.updateMessageCompletion(messageId, status, completedAt);

    const timestamps = this.repository.getMessageTimestamps(messageId);
    if (timestamps) {
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
    this.messenger.broadcast({
      type: "processing_status",
      isProcessing: this.repository.getProcessingMessage() !== null,
    });
    this.ctx.waitUntil(this.callbackService.notifyComplete(messageId, event.success, event.error));
    await this.statusService.reconcileAfterExecution(event.success);
  }

  async stopProcessingMessage(options: StopExecutionOptions = {}): Promise<void> {
    const completedAt = this.now();
    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return;

    this.repository.updateMessageCompletion(processingMessage.id, "failed", completedAt);
    this.log.info("prompt.stopped", {
      event: "prompt.stopped",
      message_id: processingMessage.id,
    });

    const error = "Execution was stopped";
    const event: ExecutionCompleteEvent = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(processingMessage.id, event, completedAt);
    this.ctx.waitUntil(
      this.terminalMessageProjection.recordTerminalMessage({
        messageId: processingMessage.id,
        messageCreatedAt: processingMessage.created_at,
        terminalMessageCompletedAt: completedAt,
      })
    );
    this.messenger.broadcast({ type: "sandbox_event", event });
    this.ctx.waitUntil(this.callbackService.notifyComplete(processingMessage.id, false, error));

    if (!options.suppressStatusReconcile) {
      await this.statusService.reconcileAfterExecution(false);
    }
  }

  async failStuckProcessingMessage(): Promise<void> {
    const completedAt = this.now();
    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return;

    this.repository.updateMessageCompletion(processingMessage.id, "failed", completedAt);

    const error = "Execution timed out (stuck processing)";
    const event: ExecutionCompleteEvent = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(processingMessage.id, event, completedAt);
    this.ctx.waitUntil(
      this.terminalMessageProjection.recordTerminalMessage({
        messageId: processingMessage.id,
        messageCreatedAt: processingMessage.created_at,
        terminalMessageCompletedAt: completedAt,
      })
    );
    this.messenger.broadcast({ type: "sandbox_event", event });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.ctx.waitUntil(this.callbackService.notifyComplete(processingMessage.id, false, error));
    await this.statusService.reconcileAfterExecution(false);
  }
}
