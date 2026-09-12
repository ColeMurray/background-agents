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
  stopConfirmationDeadline: number;
  sandboxId?: string | null;
  cleanupDeadlineMs?: number;
  failure: RecordedMessageFailure;
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
    const preparation = this.repository.transaction(() => this.prepare(reason, Date.now()));
    if (!preparation) {
      this.messenger.broadcast({ type: "processing_status", isProcessing: false });
      return;
    }
    await this.deliver(preparation);
  }

  prepare(reason: string, now: number): ExecutionStopPreparation | null {
    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    const metadata = processingMessage
      ? this.messageRepository.getMessageExecutionMetadata(processingMessage.id)
      : null;
    const cleanupDeadlineMs = processingMessage
      ? (this.messageRepository.beginMessageCleanup(processingMessage.id, now) ??
        metadata?.cleanup_deadline_ms)
      : undefined;
    const stopConfirmationDeadline = Math.min(
      now + STOP_CONFIRMATION_TIMEOUT_MS,
      cleanupDeadlineMs ?? Infinity
    );
    const failure = processingMessage
      ? this.messageFailures.record(processingMessage.id, reason, now, "processing")
      : null;
    if (!failure) return null;
    this.messageRepository.markMessageAwaitingStopConfirmation(
      failure.completion.messageId,
      stopConfirmationDeadline
    );
    this.alarmDeadlines.setPendingEarliest(stopConfirmationDeadline);
    return {
      stopConfirmationDeadline,
      failure,
      sandboxId: metadata?.execution_sandbox_id ?? null,
      cleanupDeadlineMs: cleanupDeadlineMs ?? undefined,
    };
  }

  async deliver(preparation: ExecutionStopPreparation): Promise<void> {
    this.messageFailures.deliver(preparation.failure);
    this.broadcastPromptQueue();
    this.log.info("prompt.stopped", {
      event: "prompt.stopped",
      message_id: preparation.failure.completion.messageId,
    });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });

    const currentFence = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (
      currentFence?.id !== preparation.failure.completion.messageId ||
      currentFence.deadline !== preparation.stopConfirmationDeadline
    )
      return;
    const sandboxWs = this.wsManager.getSandboxSocket();
    const stopSent =
      sandboxWs !== null &&
      this.wsManager.send(sandboxWs, {
        type: "stop",
        messageId: preparation.failure.completion.messageId,
        sandboxId: preparation.sandboxId ?? undefined,
        cleanupDeadlineMs: preparation.cleanupDeadlineMs,
      });
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
      // Stop confirmation can release the queue while reconciliation is pending.
      // A stale delivery must not terminate work started after that stop.
      const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
      if (
        awaitingStop?.id !== preparation.failure.completion.messageId ||
        awaitingStop.deadline !== preparation.stopConfirmationDeadline
      ) {
        return;
      }
      const terminated = await this.sandboxLifecycle.terminateUnresponsiveSandbox(
        reason,
        preparation.cleanupDeadlineMs
      );
      if (terminated)
        await this.resumeAfterSandboxTermination(
          preparation.failure.completion.messageId,
          preparation.sandboxId
        );
      else
        await this.retainFenceAfterFailedTermination(
          preparation.failure.completion.messageId,
          preparation.sandboxId
        );
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
    const metadata = this.messageRepository.getMessageExecutionMetadata(awaitingStop.id);
    const terminated = await this.sandboxLifecycle.terminateUnresponsiveSandbox(
      "stop_confirmation_timeout",
      metadata?.cleanup_deadline_ms ?? undefined
    );
    if (terminated)
      await this.resumeAfterSandboxTermination(awaitingStop.id, metadata?.execution_sandbox_id);
    else
      await this.retainFenceAfterFailedTermination(awaitingStop.id, metadata?.execution_sandbox_id);
  }

  private async retainFenceAfterFailedTermination(
    messageId: string,
    sandboxId?: string | null
  ): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop?.id !== messageId) return;
    const metadata = this.messageRepository.getMessageExecutionMetadata(messageId);
    if (sandboxId !== undefined && (metadata?.execution_sandbox_id ?? null) !== sandboxId) return;
    if (metadata?.requires_stop_evidence !== 1) {
      // Compatibility only: pre-capability images used best-effort detach.
      // This is expressly not evidence that provider execution has ceased.
      this.log.warn("Legacy runtime stop recovery without cessation evidence", {
        event: "prompt.stop_legacy_exception",
        message_id: messageId,
      });
      await this.resumeAfterSandboxTermination(messageId, metadata?.execution_sandbox_id);
      return;
    }
    // This is a retry of containment, never a fresh runtime cleanup allowance.
    // Keep the original cleanup deadline in metadata and the dispatch fence
    // durable even after the provider can no longer confirm termination.
    const retryAt = Date.now() + STOP_CONFIRMATION_TIMEOUT_MS;
    this.messageRepository.markMessageAwaitingStopConfirmation(messageId, retryAt);
    await this.alarmScheduler.schedule(retryAt);
  }

  async resumeAfterSandboxTermination(
    expectedMessageId: string | null,
    expectedSandboxId?: string | null
  ): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop) {
      const metadata = this.messageRepository.getMessageExecutionMetadata(awaitingStop.id);
      if (
        awaitingStop.id !== expectedMessageId ||
        (expectedSandboxId !== undefined &&
          (metadata?.execution_sandbox_id ?? null) !== expectedSandboxId)
      )
        return;
      this.messageRepository.clearMessageAwaitingStopConfirmation(awaitingStop.id);
    }
    await this.processMessageQueue();
  }
}
