import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { MessageRepository } from "../message-repository";
import type { SandboxPushService } from "../sandbox-push-service";
import type { SessionWebSocketManager } from "../websocket-manager";
import type { SandboxArtifactEventHandler } from "./artifact.handler";
import type { SandboxEventContext } from "./context";
import type { SandboxExecutionEventHandler } from "./execution.handler";
import type { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxStreamingEventHandler } from "./streaming.handler";

type SandboxEventWithAck = SandboxEvent & { ackId?: string };
const LOG_METADATA_MAX_CHARS = 256;

/** Metadata only: never copy event content, arguments, results, or error text. */
function eventLogContext(event: SandboxEventWithAck, messageId: string | null) {
  const fields: Record<string, unknown> = {
    event_type: event.type,
    message_id: messageId,
  };
  if ("sandboxId" in event) fields.sandbox_id = event.sandboxId;
  if (event.ackId) fields.ack_id = event.ackId;
  if ("callId" in event) fields.call_id = event.callId;
  if ("taskCallId" in event) fields.task_call_id = event.taskCallId;
  if ("childSessionId" in event) fields.child_session_id = event.childSessionId;
  if ("stepId" in event) fields.step_id = event.stepId;
  if ("operationId" in event) fields.operation_id = event.operationId;
  if ("isSubtask" in event) fields.is_subtask = event.isSubtask;
  if ("status" in event) fields.status = event.status;
  if ("success" in event) fields.success = event.success;
  if ("tool" in event) fields.tool = event.tool;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.length > LOG_METADATA_MAX_CHARS) {
      fields[key] = value.slice(0, LOG_METADATA_MAX_CHARS);
      fields.metadata_truncated = true;
    }
  }
  return fields;
}

/** Event types that require delivery acknowledgement. */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "execution_complete",
  "error",
  "snapshot_ready",
  "push_complete",
  "push_error",
  "sandbox_generation_ready",
  "preservation_prepared",
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
    private readonly pushService: SandboxPushService,
    private readonly shutdown?: {
      generationReady(event: Extract<SandboxEvent, { type: "sandbox_generation_ready" }>): void;
      prepared(event: Extract<SandboxEvent, { type: "preservation_prepared" }>): void;
    }
  ) {}

  async processSandboxEvent(event: SandboxEventWithAck): Promise<void> {
    const now = Date.now();
    const eventMessageId = "messageId" in event ? event.messageId : null;
    let fields = eventLogContext(event, eventMessageId ?? null);
    const level = event.type === "heartbeat" || event.type === "token" ? "debug" : "info";
    this.log[level]("sandbox.event.received", fields);
    const startedAt = performance.now();
    try {
      const processingMessage = this.messageRepository.getProcessingMessage();
      const context: SandboxEventContext = {
        now,
        messageId: eventMessageId ?? processingMessage?.id ?? null,
        processingMessage,
      };
      fields = eventLogContext(event, context.messageId);
      await this.dispatch(event, context);
    } catch (error) {
      this.log.error("sandbox.event.processing_failed", {
        ...fields,
        duration_ms: Math.round(performance.now() - startedAt),
        error_type: error instanceof Error ? error.constructor.name : typeof error,
      });
      throw error;
    }
    // Dispatch finished; background callbacks and client delivery may still be pending.
    this.log[level]("sandbox.event.processed", {
      ...fields,
      duration_ms: Math.round(performance.now() - startedAt),
    });

    if (CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(event.ackId, fields);
    }
  }

  private async dispatch(event: SandboxEvent, context: SandboxEventContext): Promise<void> {
    switch (event.type) {
      case "sandbox_generation_ready":
        if (!this.shutdown) {
          throw new Error("Sandbox graceful shutdown event handlers are not configured");
        }
        this.shutdown.generationReady(event);
        return;
      case "preservation_prepared":
        if (!this.shutdown) {
          throw new Error("Sandbox graceful shutdown event handlers are not configured");
        }
        this.shutdown.prepared(event);
        return;
      case "heartbeat":
        this.runtime.handleHeartbeat(context);
        return;
      case "session_title":
        this.runtime.handleSessionTitle(event);
        return;
      case "ready":
        await this.runtime.handleReady(event, context);
        return;
      case "boot_progress":
        this.runtime.handleBootProgress(event, context);
        return;
      case "git_sync":
        this.runtime.handleGitSync(event, context);
        return;
      case "artifact":
        this.artifacts.handleArtifact(event, context);
        return;
      case "token":
        this.streaming.handleToken(event, context);
        return;
      case "context_compacted":
        this.streaming.handleContextCompacted(event, context);
        return;
      case "step_start":
      case "step_finish":
        await this.streaming.handleStep(event, context);
        return;
      case "tool_call":
        this.streaming.handleToolCall(event, context);
        return;
      case "execution_complete":
        await this.execution.handleExecutionComplete(event, context);
        return;
      case "push_complete":
      case "push_error":
        // Observed like any other timeline event; additionally answers the
        // push the sandbox was asked to perform. The settle continuation runs
        // on a microtask, so it cannot observe this dispatch mid-flight.
        this.streaming.recordTimelineEvent(event, context);
        this.pushService.settlePush(event);
        return;
      case "tool_result":
      case "error":
      case "warning":
      case "user_message":
        // Timeline-observer events: persist and broadcast, nothing else.
        this.streaming.recordTimelineEvent(event, context);
        return;
      case "snapshot_ready":
        // The bridge's answer to the snapshot command. The lifecycle manager
        // drives the snapshot itself through the provider; all this needs is
        // the delivery ack below, which stops the bridge re-sending it.
        return;
      default:
        // Exhaustive: a new SandboxEvent variant must pick a family here.
        event satisfies never;
        return;
    }
  }

  private sendAck(ackId: string | undefined, fields: Record<string, unknown>): void {
    if (!ackId) {
      this.log.info("sandbox.event.ack", { ...fields, outcome: "missing_id" });
      return;
    }
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      this.log.warn("sandbox.event.ack", { ...fields, outcome: "no_socket" });
      return;
    }
    const sent = this.wsManager.send(sandboxWs, { type: "ack", ackId });
    this.log[sent ? "info" : "warn"]("sandbox.event.ack", {
      ...fields,
      outcome: sent ? "sent" : "send_failed",
    });
  }
}
