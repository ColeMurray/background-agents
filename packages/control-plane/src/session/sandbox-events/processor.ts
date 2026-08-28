import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { MessageRepository } from "../message-repository";
import type { SandboxPushService } from "../sandbox-push-service";
import type { SandboxSenderContext, SessionWebSocketManager } from "../websocket-manager";
import type { SandboxArtifactEventHandler } from "./artifact.handler";
import type { SandboxEventContext } from "./context";
import type { SandboxExecutionEventHandler } from "./execution.handler";
import type { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxStreamingEventHandler } from "./streaming.handler";

type SandboxEventWithAck = SandboxEvent & { ackId?: string };

/** Event types that require delivery acknowledgement. */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "execution_complete",
  "error",
  "snapshot_ready",
  "push_complete",
  "push_error",
]);

/**
 * Routes validated sandbox events to their family handlers. Owns exactly the
 * cross-family concerns: arrival logging, the per-event context (one clock
 * reading, one message-attribution resolution), and the delivery-ack
 * contract — the ack for a critical event is sent after its handler finishes,
 * and family handlers never see `ackId`.
 */
export class SessionSandboxEventProcessor {
  constructor(
    private readonly log: Logger,
    private readonly messageRepository: MessageRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly streaming: SandboxStreamingEventHandler,
    private readonly artifacts: SandboxArtifactEventHandler,
    private readonly execution: SandboxExecutionEventHandler,
    private readonly runtime: SandboxRuntimeEventHandler,
    private readonly pushService: SandboxPushService
  ) {}

  async processSandboxEvent(
    event: SandboxEventWithAck,
    sender: SandboxSenderContext | null = null
  ): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.log.info("Sandbox event", { event_type: event.type });
    }

    const now = Date.now();
    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.messageRepository.getProcessingMessage();
    const context: SandboxEventContext = {
      now,
      messageId: eventMessageId ?? processingMessage?.id ?? null,
      processingMessage,
      sender,
    };

    const shouldAck = await this.dispatch(event, context);

    if (shouldAck && CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(event.ackId, sender?.socket ?? null);
    }
  }

  private async dispatch(event: SandboxEvent, context: SandboxEventContext): Promise<boolean> {
    switch (event.type) {
      case "heartbeat":
        this.runtime.handleHeartbeat(event, context);
        return true;
      case "boot_phase":
        this.runtime.handleBootPhase(event, context);
        return true;
      case "boot_failed":
        return this.runtime.handleBootFailed(event, context);
      case "session_title":
        this.runtime.handleSessionTitle(event);
        return true;
      case "ready":
        await this.runtime.handleReady(event, context);
        return true;
      case "git_sync":
        this.runtime.handleGitSync(event, context);
        return true;
      case "artifact":
        this.artifacts.handleArtifact(event, context);
        return true;
      case "token":
        this.streaming.handleToken(event, context);
        return true;
      case "context_compacted":
        this.streaming.handleContextCompacted(event, context);
        return true;
      case "step_start":
      case "step_finish":
        this.streaming.handleStep(event, context);
        return true;
      case "tool_call":
        this.streaming.handleToolCall(event, context);
        return true;
      case "execution_complete":
        await this.execution.handleExecutionComplete(event, context);
        return true;
      case "push_complete":
      case "push_error":
        // Observed like any other timeline event; additionally answers the
        // push the sandbox was asked to perform. The settle continuation runs
        // on a microtask, so it cannot observe this dispatch mid-flight.
        this.streaming.recordTimelineEvent(event, context);
        this.pushService.settlePush(event);
        return true;
      case "tool_result":
      case "error":
      case "warning":
      case "user_message":
        // Timeline-observer events: persist and broadcast, nothing else.
        this.streaming.recordTimelineEvent(event, context);
        return true;
      default:
        // Exhaustive: a new SandboxEvent variant must pick a family here.
        event satisfies never;
        return true;
    }
  }

  private sendAck(ackId: string | undefined, capturedSender: WebSocket | null): void {
    if (!ackId) return;
    const sandboxWs = capturedSender ?? this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "ack", ackId });
    } else {
      this.log.debug("Cannot send ACK: no sandbox socket", { ack_id: ackId });
    }
  }
}
