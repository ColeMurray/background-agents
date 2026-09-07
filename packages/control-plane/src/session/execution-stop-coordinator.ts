import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { AlarmDeadlineStore } from "./alarm/scheduler";
import type { MessageRepository } from "./message-repository";
import type { MessageFailureService, RecordedMessageFailure } from "./message-failure-service";
import { STOP_CONFIRMATION_TIMEOUT_MS } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionWebSocketManager } from "./websocket-manager";

export interface ExecutionStopPreparation {
  stopped: boolean;
  processingMessageId: string | null;
  stopConfirmationDeadline: number | null;
  failure: RecordedMessageFailure | null;
}

export class ExecutionStopCoordinator {
  constructor(
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly sessionStatus: SessionStatusService,
    private readonly messageFailures: MessageFailureService,
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
      ? this.messageFailures.record(processingMessage.id, reason, now, "processing")
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
    this.messageFailures.deliver(preparation.failure);
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
}
