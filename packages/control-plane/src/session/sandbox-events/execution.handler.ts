import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { BackgroundTasks } from "../../platform-ports";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { MessageRepository } from "../message-repository";
import type { SessionMessenger } from "../messenger";
import type { SessionStatusService } from "../session-status-service";
import type { SandboxEventContext } from "./context";
import type { SessionBudgetService } from "../budget-service";

/**
 * Execution-lifecycle family: settle a finished turn. `execution_complete`
 * is the convergence point of the session — message completion, terminal
 * projection, client broadcasts, queue release, callbacks, snapshotting,
 * activity accounting, and the status reconcile all meet here, which is why
 * this handler is the widest of the families. A planned single-writer rework
 * of session status and its D1 projection is expected to fold
 * `projectTerminalMessage` and parts of `statusService` into one projection
 * surface; re-measure this class after that lands before splitting further.
 */
export class SandboxExecutionEventHandler {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly messageRepository: MessageRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly messenger: SessionMessenger,
    private readonly projectTerminalMessage: (
      messageId: string,
      messageCreatedAt: number,
      completedAt: number
    ) => Promise<void>,
    private readonly statusService: SessionStatusService,
    private readonly triggerSnapshot: (reason: string) => Promise<void>,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly scheduleInactivityCheck: () => Promise<void>,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly broadcastPromptQueue: () => void,
    private readonly budget: Pick<
      SessionBudgetService,
      "observeExecutionCost" | "deliverTransition"
    >,
    private readonly transaction: <T>(closure: () => T) => T
  ) {}

  async handleExecutionComplete(
    event: Extract<SandboxEvent, { type: "execution_complete" }>,
    context: SandboxEventContext
  ): Promise<void> {
    // Release the processing/stop fence and settle final cost in one commit.
    // No queue invocation may see a finished turn with its budget still stale.
    const { completion, budgetTransition } = this.transaction(() => {
      const completion =
        context.processingMessage?.id === event.messageId
          ? this.messageRepository.recordMessageCompletion(event, context.now, "processing")
          : null;
      if (!completion) this.messageRepository.clearMessageAwaitingStopConfirmation(event.messageId);
      return {
        completion,
        budgetTransition: this.budget.observeExecutionCost(event, context.now),
      };
    });
    await this.budget.deliverTransition(budgetTransition);
    if (completion) {
      await this.projectTerminalMessage(
        completion.messageId,
        completion.messageCreatedAt,
        completion.completedAt
      );
      const totalDurationMs = context.now - completion.messageCreatedAt;
      const processingDurationMs =
        completion.messageStartedAt != null ? context.now - completion.messageStartedAt : undefined;
      const queueDurationMs =
        completion.messageStartedAt != null
          ? completion.messageStartedAt - completion.messageCreatedAt
          : undefined;
      this.log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: event.messageId,
        outcome: event.success ? "success" : "failure",
        message_status: completion.status,
        total_duration_ms: totalDurationMs,
        processing_duration_ms: processingDurationMs,
        queue_duration_ms: queueDurationMs,
      });
      this.messenger.broadcast({ type: "sandbox_event", event });
      this.messenger.broadcast({
        type: "processing_status",
        isProcessing: this.messageRepository.getProcessingMessage() !== null,
      });
      this.broadcastPromptQueue();
      this.backgroundTasks.submit(
        () => this.callbackService.notifyComplete(event.messageId, event.success, event.error),
        {
          name: "callback.notify_complete",
          context: { message_id: event.messageId },
        }
      );
      await this.statusService.reconcileAfterExecution(event.success);
    } else {
      this.log.info("prompt.complete", {
        event: "prompt.complete",
        message_id: event.messageId,
        outcome: "already_stopped",
      });
    }

    this.backgroundTasks.submit(() => this.triggerSnapshot("execution_complete"), {
      name: "snapshot.trigger",
      context: { reason: "execution_complete", message_id: event.messageId },
    });
    this.updateLastActivity(context.now);
    await this.scheduleInactivityCheck();
    await this.processMessageQueue();
  }
}
