import type { Logger } from "../logger";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionMessenger } from "./messenger";
import type { SessionRepository } from "./repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionTerminalMessageProjection } from "./terminal-message-projection";

type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

export interface SessionExecutionCompletion {
  completeFromSandbox(event: ExecutionCompleteEvent, completedAt: number): Promise<void>;
  stopProcessingMessage(): Promise<string | null>;
  failStuckProcessingMessage(): Promise<boolean>;
  cancelUnfinishedMessages(): void;
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
    private readonly broadcastPromptQueue: () => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  async completeFromSandbox(event: ExecutionCompleteEvent, completedAt: number): Promise<void> {
    const processingMessage = this.repository.getProcessingMessage();
    if (processingMessage?.id !== event.messageId) {
      this.repository.clearMessageAwaitingStopConfirmation(event.messageId);
      this.log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: event.messageId,
        outcome: "already_stopped",
      });
      return;
    }

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
    this.messenger.broadcast({
      type: "processing_status",
      isProcessing: this.repository.getProcessingMessage() !== null,
    });
    this.broadcastPromptQueue();
    this.scheduleCompletionCallback(messageId, event.success, event.error);
    await this.statusService.reconcileAfterExecution(event.success);
  }

  async stopProcessingMessage(): Promise<string | null> {
    const message = this.failProcessingMessage("Execution was stopped");
    return message?.id ?? null;
  }

  async failStuckProcessingMessage(): Promise<boolean> {
    return this.failProcessingMessage("Execution timed out (stuck processing)") !== null;
  }

  cancelUnfinishedMessages(): void {
    const completedAt = this.now();
    for (const message of this.repository.listPendingMessagesWithCreatedAt()) {
      this.failMessage(message, "Execution was cancelled before it started", completedAt);
    }

    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (processingMessage) {
      this.failMessage(processingMessage, "Execution was cancelled", completedAt);
    }
  }

  private failProcessingMessage(error: string): { id: string; created_at: number } | null {
    const completedAt = this.now();
    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return null;

    this.failMessage(processingMessage, error, completedAt);
    return processingMessage;
  }

  private failMessage(
    processingMessage: { id: string; created_at: number },
    error: string,
    completedAt: number
  ): void {
    this.repository.updateMessageCompletion(processingMessage.id, "failed", completedAt, error);
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
    this.scheduleCompletionCallback(processingMessage.id, false, error);
  }

  private scheduleCompletionCallback(messageId: string, success: boolean, error?: string): void {
    this.ctx.waitUntil(
      this.callbackService.notifyComplete(messageId, success, error).catch((callbackError) => {
        this.log.error("callback.complete.background_error", {
          message_id: messageId,
          error: callbackError,
        });
      })
    );
  }
}
