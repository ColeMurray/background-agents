import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { MessageRepository, RecordedMessageCompletion } from "./message-repository";
import type { SessionMessenger } from "./messenger";

export interface RecordedMessageFailure {
  event: Extract<SandboxEvent, { type: "execution_complete" }>;
  completion: RecordedMessageCompletion;
}

/** One failure policy for queued, timed-out, cancelled, and budget-stopped work. */
export class MessageFailureService {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: MessageRepository,
    private readonly messenger: SessionMessenger,
    private readonly callbacks: CallbackNotificationService,
    private readonly projectTerminalMessage: (
      messageId: string,
      messageCreatedAt: number,
      completedAt: number
    ) => Promise<void>
  ) {}

  /** Record synchronously so a caller can include its stop fence in the same transaction. */
  record(
    messageId: string,
    error: string,
    completedAt: number,
    expectedStatus: "pending" | "processing"
  ): RecordedMessageFailure | null {
    const event: RecordedMessageFailure["event"] = {
      type: "execution_complete",
      messageId,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    const completion = this.repository.recordMessageCompletion(event, completedAt, expectedStatus);
    return completion ? { event, completion } : null;
  }

  /** Publish only after the transaction containing record() has committed. */
  deliver({ event, completion }: RecordedMessageFailure): void {
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
      () => this.callbacks.notifyComplete(completion.messageId, false, event.error),
      { name: "callback.notify_complete", context: { message_id: completion.messageId } }
    );
  }
}
