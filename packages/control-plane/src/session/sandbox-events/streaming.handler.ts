import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { generateId } from "../../auth/crypto";
import type { BackgroundTasks } from "../../platform-ports";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SessionCoreRepository } from "../session-core-repository";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

/**
 * Streaming/timeline family: the high-frequency events that narrate an
 * execution (tokens, steps, tool activity, compaction). Every event here is
 * broadcast to clients; the ones with a durable representation also record
 * to the timeline (steps only renew activity and accumulate cost). Nothing
 * here transitions session state. Also owns the timeline-observer path
 * (`recordTimelineEvent`) for events that persist and broadcast unchanged.
 */
export class SandboxStreamingEventHandler {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly repository: SessionCoreRepository,
    private readonly eventRepository: EventRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly messenger: SessionMessenger,
    private readonly updateLastActivity: (timestamp: number) => void
  ) {}

  handleToken(event: Extract<SandboxEvent, { type: "token" }>, context: SandboxEventContext): void {
    if (context.messageId) {
      this.eventRepository.upsertTokenEvent(context.messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleContextCompacted(
    event: Extract<SandboxEvent, { type: "context_compacted" }>,
    context: SandboxEventContext
  ): void {
    const eventId = generateId();
    this.eventRepository.createContextCompactionEvent({
      id: eventId,
      type: event.type,
      data: JSON.stringify(event),
      messageId: event.messageId,
      createdAt: context.now,
    });
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleStep(
    event: Extract<SandboxEvent, { type: "step_start" | "step_finish" }>,
    context: SandboxEventContext
  ): void {
    this.updateLastActivity(context.now);
    if (
      event.type === "step_finish" &&
      typeof event.cost === "number" &&
      Number.isFinite(event.cost) &&
      event.cost > 0
    ) {
      this.repository.addSessionCost(event.cost, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }

  handleToolCall(
    event: Extract<SandboxEvent, { type: "tool_call" }>,
    context: SandboxEventContext
  ): void {
    this.updateLastActivity(context.now);
    const messageId = context.messageId;
    if (messageId) {
      this.eventRepository.upsertToolCallEvent(messageId, event, context.now);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });

    if (messageId) {
      this.backgroundTasks.submit(() => this.callbackService.notifyToolCall(messageId, event), {
        name: "callback.notify_tool_call",
        context: { message_id: messageId },
      });
    }
  }

  /**
   * Persist-and-broadcast for the router's timeline-observer cases
   * (`tool_result`, `error`, `warning`, `user_message`, and the push
   * terminal events, which additionally settle `SandboxPushService`).
   */
  recordTimelineEvent(event: SandboxEvent, context: SandboxEventContext): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
  }
}
