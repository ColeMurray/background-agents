import type { Logger } from "../../logger";
import { evaluateExecutionTimeout } from "../../sandbox/lifecycle/decisions";
import type { SandboxLifecycleManager } from "../../sandbox/lifecycle/manager";
import type { AlarmScheduler } from "../../platform-ports";
import type { SessionMessageQueue } from "../message-queue";
import type { MessageRepository } from "../message-repository";

export interface AlarmHandlerDeps {
  repository: MessageRepository;
  messageQueue: Pick<
    SessionMessageQueue,
    | "failStuckProcessingMessage"
    | "recoverStopConfirmationTimeout"
    | "resumeAfterSandboxTermination"
  >;
  lifecycleManager: Pick<SandboxLifecycleManager, "handleAlarm">;
  alarmScheduler: AlarmScheduler;
  /** Resolved per use so it honors settings persisted after construction. */
  getExecutionTimeoutMs: () => number;
  now: () => number;
  /** Session-scoped logger — alarms run outside any request, so there is no request correlation. */
  log: Logger;
}

export interface AlarmHandler {
  handle: () => Promise<void>;
}

/**
 * Durable Object alarm handler.
 *
 * Checks for stuck processing messages (defense-in-depth execution timeout)
 * before delegating to lifecycle alarm processing.
 */
export function createAlarmHandler(deps: AlarmHandlerDeps): AlarmHandler {
  return {
    async handle(): Promise<void> {
      await deps.messageQueue.recoverStopConfirmationTimeout();
      // Execution timeout check: if a message has been in 'processing' longer than
      // the configured timeout, fail it. This is idempotent - if the message was
      // already failed (by lifecycle recovery or a prior alarm),
      // getProcessingMessageWithStartedAt() returns null.
      const processing = deps.repository.getProcessingMessageWithStartedAt();
      if (processing?.started_at) {
        const now = deps.now();
        const executionTimeoutMs = deps.getExecutionTimeoutMs();
        const result = evaluateExecutionTimeout(
          processing.started_at,
          { timeoutMs: executionTimeoutMs },
          now
        );
        if (result.isTimedOut) {
          deps.log.warn("Execution timeout: message stuck in processing", {
            event: "execution.timeout",
            message_id: processing.id,
            elapsed_ms: result.elapsedMs,
            timeout_ms: executionTimeoutMs,
          });
          await deps.messageQueue.failStuckProcessingMessage();
        } else {
          // An earlier lifecycle alarm has consumed the Durable Object's single
          // alarm slot. Reassert this message's deadline before lifecycle handling
          // schedules its next check so stuck-message recovery cannot be delayed.
          await deps.alarmScheduler.schedule(processing.started_at + executionTimeoutMs);
        }
      }

      const lifecycleResult = await deps.lifecycleManager.handleAlarm();
      if (lifecycleResult !== "no_action") {
        await deps.messageQueue.failStuckProcessingMessage();
      }
      if (lifecycleResult === "sandbox_terminated") {
        await deps.messageQueue.resumeAfterSandboxTermination();
      }
    },
  };
}
