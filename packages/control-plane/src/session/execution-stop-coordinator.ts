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

export const MAX_STOP_CONTAINMENT_ATTEMPTS = 5;
export const MAX_STOP_CONTAINMENT_RETRY_DELAY_MS = 60_000;

export interface DispatchRecoveryPreparation {
  messageId: string;
  sandboxId: string | null;
}

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

  prepareDispatchRecovery(messageId: string, now: number): DispatchRecoveryPreparation | null {
    const metadata = this.messageRepository.getMessageExecutionMetadata(messageId);
    const deadline = Math.min(
      now + STOP_CONFIRMATION_TIMEOUT_MS,
      metadata?.cleanup_deadline_ms ?? Infinity
    );
    const prepared = this.messageRepository.prepareDispatchRecovery(messageId, deadline, () =>
      this.alarmDeadlines.setPendingEarliest(deadline)
    );
    return prepared ? { messageId, sandboxId: metadata?.execution_sandbox_id ?? null } : null;
  }

  async deliverDispatchRecovery(preparation: DispatchRecoveryPreparation): Promise<void> {
    await this.terminateFencedExecution(
      preparation.messageId,
      preparation.sandboxId,
      "prompt_dispatch_send_failed"
    );
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
      await this.terminateFencedExecution(
        preparation.failure.completion.messageId,
        preparation.sandboxId,
        reason
      );
    }
  }

  async recoverStopConfirmationTimeout(): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (!awaitingStop) return;
    const metadata = this.messageRepository.getMessageExecutionMetadata(awaitingStop.id);
    if (metadata?.stop_escalated_at != null) return;
    if (awaitingStop.deadline > Date.now()) {
      // An earlier deadline may have consumed the single alarm slot; keep
      // this one armed so the stop cannot wait on unrelated work.
      await this.alarmScheduler.schedule(awaitingStop.deadline);
      return;
    }
    this.log.warn("Sandbox did not confirm stop before deadline", {
      event: "prompt.stop_confirmation_timeout",
      message_id: awaitingStop.id,
      containment_attempts: metadata?.stop_containment_attempts ?? 0,
      max_containment_attempts: MAX_STOP_CONTAINMENT_ATTEMPTS,
    });
    await this.terminateFencedExecution(
      awaitingStop.id,
      metadata?.execution_sandbox_id,
      "stop_confirmation_timeout"
    );
  }

  private async terminateFencedExecution(
    messageId: string,
    sandboxId: string | null | undefined,
    reason: Parameters<SandboxLifecycle["terminateUnresponsiveSandbox"]>[0]
  ): Promise<void> {
    const metadata = this.messageRepository.getMessageExecutionMetadata(messageId);
    if (
      this.messageRepository.getMessageAwaitingStopConfirmation()?.id !== messageId ||
      (sandboxId !== undefined && (metadata?.execution_sandbox_id ?? null) !== sandboxId) ||
      metadata?.stop_escalated_at != null
    )
      return;
    if (metadata?.requires_stop_evidence === 1) {
      const attempts = metadata.stop_containment_attempts ?? 0;
      if (attempts >= MAX_STOP_CONTAINMENT_ATTEMPTS) {
        this.escalateContainment(messageId);
        return;
      }
      const retryAt =
        Date.now() +
        Math.min(STOP_CONFIRMATION_TIMEOUT_MS * 2 ** attempts, MAX_STOP_CONTAINMENT_RETRY_DELAY_MS);
      const attempt = this.messageRepository.claimStopContainmentAttempt(
        messageId,
        retryAt,
        MAX_STOP_CONTAINMENT_ATTEMPTS,
        () => this.alarmDeadlines.setPendingEarliest(retryAt)
      );
      if (attempt === null) return;
      // Intent and attempt count are durable already. A failed runtime alarm
      // write must not prevent containment, and rehydration can re-arm it.
      try {
        await this.alarmScheduler.schedule(retryAt);
      } catch (error) {
        this.log.error("Containment retry alarm failed", {
          message_id: messageId,
          containment_attempt: attempt,
          error,
        });
      }
    }
    const currentMetadata = this.messageRepository.getMessageExecutionMetadata(messageId);
    if (
      this.messageRepository.getMessageAwaitingStopConfirmation()?.id !== messageId ||
      (sandboxId !== undefined && (currentMetadata?.execution_sandbox_id ?? null) !== sandboxId) ||
      currentMetadata?.stop_escalated_at != null
    )
      return;
    const terminated = await this.sandboxLifecycle.terminateUnresponsiveSandbox(
      reason,
      currentMetadata?.cleanup_deadline_ms ?? undefined
    );
    if (terminated) await this.resumeAfterSandboxTermination(messageId, sandboxId);
    else await this.retainFenceAfterFailedTermination(messageId, sandboxId);
  }

  private escalateContainment(messageId: string): void {
    const event = this.messageRepository.recordStopContainmentEscalation(messageId, Date.now());
    if (!event) return;
    this.log.error("Automatic execution containment exhausted", {
      event: "prompt.stop_containment_escalated",
      message_id: messageId,
      containment_attempts: MAX_STOP_CONTAINMENT_ATTEMPTS,
    });
    this.messenger.broadcast({ type: "sandbox_event", event });
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
    if ((metadata.stop_containment_attempts ?? 0) >= MAX_STOP_CONTAINMENT_ATTEMPTS) {
      this.escalateContainment(messageId);
    }
    // Otherwise the capped retry and its alarm intent were persisted before
    // the attempt. Neither failure nor hibernation grants another allowance.
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
