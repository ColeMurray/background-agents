import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { AlarmDeadlineStore } from "./alarm/scheduler";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { MessageRepository, RecordedMessageCompletion } from "./message-repository";
import { STOP_CONFIRMATION_TIMEOUT_MS } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionWebSocketManager } from "./websocket-manager";

interface RecordedMessageFailure {
  event: Extract<SandboxEvent, { type: "execution_complete" }>;
  completion: RecordedMessageCompletion;
}

export interface ExecutionStopPreparation {
  stopped: boolean;
  processingMessageId: string | null;
  stopConfirmationDeadline: number | null;
  failure: RecordedMessageFailure | null;
}

export class ExecutionStopCoordinator {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly callbackService: CallbackNotificationService,
    private readonly sessionStatus: SessionStatusService,
    private readonly projectTerminalMessage: (
      messageId: string,
      messageCreatedAt: number,
      completedAt: number
    ) => Promise<void>,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly alarmDeadlines: AlarmDeadlineStore,
    private readonly broadcastPromptQueue: () => void,
    private readonly processMessageQueue: () => Promise<void>
  ) {}

  async stop(reason = "Execution was stopped"): Promise<void> {
    let preparation!: ExecutionStopPreparation;
    this.repository.transaction(() => {
      preparation = this.prepare(reason, Date.now());
    });
    if (!preparation.stopped) {
      this.messenger.broadcast({ type: "processing_status", isProcessing: false });
      return;
    }
    await this.deliver(preparation);
  }

  prepare(reason: string, now: number): ExecutionStopPreparation {
    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    const stopConfirmationDeadline = now + STOP_CONFIRMATION_TIMEOUT_MS;
    const failure = processingMessage
      ? this.recordMessageFailure(processingMessage, reason, now)
      : null;
    if (processingMessage && failure) {
      this.messageRepository.markMessageAwaitingStopConfirmation(
        processingMessage.id,
        stopConfirmationDeadline
      );
      this.alarmDeadlines.setPendingEarliest(stopConfirmationDeadline);
    }
    return {
      stopped: failure !== null,
      processingMessageId: failure ? (processingMessage?.id ?? null) : null,
      stopConfirmationDeadline: failure ? stopConfirmationDeadline : null,
      failure,
    };
  }

  async deliver(preparation: ExecutionStopPreparation): Promise<void> {
    if (
      !preparation.failure ||
      !preparation.processingMessageId ||
      preparation.stopConfirmationDeadline === null
    ) {
      return;
    }
    this.projectMessageFailure(preparation.failure);
    this.broadcastPromptQueue();
    this.log.info("prompt.stopped", {
      event: "prompt.stopped",
      message_id: preparation.processingMessageId,
    });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.wsManager.getSandboxSocket();
    const stopSent = sandboxWs !== null && this.wsManager.send(sandboxWs, { type: "stop" });
    const [alarm, status] = await Promise.allSettled([
      this.alarmScheduler.schedule(preparation.stopConfirmationDeadline),
      this.sessionStatus.reconcileAfterExecution(false),
    ]);
    if (status.status === "rejected") {
      this.log.error("Stop status reconciliation failed", { error: status.reason });
    }
    if (!stopSent || alarm.status === "rejected") {
      const reason = stopSent ? "stop_alarm_failed" : "stop_send_failed";
      if (alarm.status === "rejected") {
        this.log.error("Stop confirmation alarm failed", { error: alarm.reason });
      }
      await this.sandboxLifecycle.terminateUnresponsiveSandbox(reason);
      await this.resumeAfterSandboxTermination();
    }
  }

  async recoverStopConfirmationTimeout(): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (!awaitingStop) return;
    if (awaitingStop.deadline > Date.now()) {
      // An earlier deadline may have consumed the single alarm slot; keep
      // this one armed so the stop cannot wait on unrelated work.
      await this.alarmScheduler.schedule(awaitingStop.deadline);
      return;
    }
    this.log.warn("Sandbox did not confirm stop before deadline", {
      event: "prompt.stop_confirmation_timeout",
      message_id: awaitingStop.id,
    });
    await this.sandboxLifecycle.terminateUnresponsiveSandbox("stop_confirmation_timeout");
    await this.resumeAfterSandboxTermination();
  }

  async resumeAfterSandboxTermination(): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop) {
      this.messageRepository.clearMessageAwaitingStopConfirmation(awaitingStop.id);
    }
    await this.processMessageQueue();
  }

  private recordMessageFailure(
    message: { id: string; created_at: number },
    error: string,
    completedAt: number
  ): RecordedMessageFailure | null {
    const event: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: message.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    const completion = this.messageRepository.recordMessageCompletion(
      event,
      completedAt,
      "processing"
    );
    return completion ? { event, completion } : null;
  }

  private projectMessageFailure({ event, completion }: RecordedMessageFailure): void {
    this.backgroundTasks.submit(
      () =>
        this.projectTerminalMessage(
          completion.messageId,
          completion.messageCreatedAt,
          completion.completedAt
        )
          .catch((error) => {
            this.log.error("terminal_message.projection_failed", {
              message_id: completion.messageId,
              error,
            });
          })
          .then(() => this.messenger.broadcast({ type: "sandbox_event", event })),
      { name: "terminal_message.project", context: { message_id: completion.messageId } }
    );
    this.backgroundTasks.submit(
      () => this.callbackService.notifyComplete(completion.messageId, false, event.error),
      { name: "callback.notify_complete", context: { message_id: completion.messageId } }
    );
  }
}
