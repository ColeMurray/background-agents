import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { MessageRepository } from "../message-repository";
import type { SessionWebSocketManager } from "../websocket-manager";
import type { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxStreamingEventHandler } from "./streaming.handler";
import { SessionSandboxEventProcessor } from "./processor";

type ShutdownEvent = Extract<
  SandboxEvent,
  { type: "sandbox_generation_ready" | "preservation_prepared" }
>;

function createProcessor() {
  const sandboxSocket = {} as WebSocket;
  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const repository = {
    getProcessingMessage: vi.fn<() => { id: string } | null>(() => null),
  };
  const wsManager = {
    getSandboxSocket: vi.fn<() => WebSocket | null>(() => sandboxSocket),
    send: vi.fn(() => true),
  };
  const streaming = {
    handleToken: vi.fn(),
    handleToolCall: vi.fn(),
    recordTimelineEvent: vi.fn(),
  };
  const runtime = { handleHeartbeat: vi.fn() };
  const shutdown = {
    generationReady: vi.fn<(event: ShutdownEvent) => void>(),
    prepared: vi.fn<(event: ShutdownEvent) => void>(),
  };
  const processor = new SessionSandboxEventProcessor(
    log as unknown as Logger,
    repository as unknown as MessageRepository,
    wsManager as unknown as SessionWebSocketManager,
    streaming as unknown as SandboxStreamingEventHandler,
    // Shutdown events must not depend on any other event-family handler.
    undefined as never,
    undefined as never,
    runtime as unknown as SandboxRuntimeEventHandler,
    undefined as never,
    shutdown
  );
  return {
    processor,
    sandboxSocket,
    log,
    repository,
    wsManager,
    send: wsManager.send,
    streaming,
    shutdown,
  };
}

describe.each([
  {
    handler: "generationReady" as const,
    event: {
      type: "sandbox_generation_ready",
      sandboxId: "sandbox-1",
      generation: { sandboxId: "sandbox-1", createdAt: 1_000 },
      timestamp: 2,
      ackId: "sandbox_generation_ready:1",
    } satisfies ShutdownEvent,
  },
  {
    handler: "prepared" as const,
    event: {
      type: "preservation_prepared",
      sandboxId: "sandbox-1",
      operationId: "operation-1",
      generation: { sandboxId: "sandbox-1", createdAt: 1_000 },
      executionStopped: true,
      timestamp: 2,
      ackId: "preservation_prepared:1",
    } satisfies ShutdownEvent,
  },
])("SessionSandboxEventProcessor $event.type ACK boundary", ({ event, handler }) => {
  it("completes the durable shutdown handler before sending ACK", async () => {
    const h = createProcessor();
    let persistedEvent: ShutdownEvent | undefined;
    h.shutdown[handler].mockImplementation((received) => {
      expect(h.send).not.toHaveBeenCalled();
      persistedEvent = structuredClone(received);
    });
    h.send.mockImplementation(() => {
      expect(persistedEvent).toEqual(event);
      return true;
    });

    await h.processor.processSandboxEvent(event);

    expect(h.shutdown[handler]).toHaveBeenCalledExactlyOnceWith(event);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.sandboxSocket, {
      type: "ack",
      ackId: event.ackId,
    });
  });

  it("propagates a shutdown handler failure without sending ACK", async () => {
    const h = createProcessor();
    const error = new Error("shutdown persistence failed");
    h.shutdown[handler].mockImplementation(() => {
      throw error;
    });

    await expect(h.processor.processSandboxEvent(event)).rejects.toBe(error);

    expect(h.shutdown[handler]).toHaveBeenCalledExactlyOnceWith(event);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("SessionSandboxEventProcessor event diagnostics", () => {
  it("correlates tool processing without logging content or credentials", async () => {
    const h = createProcessor();
    const event = {
      type: "tool_call",
      sandboxId: "sb-1",
      timestamp: 1000,
      messageId: "msg-1",
      callId: "call-1",
      taskCallId: "parent-1",
      childSessionId: "child-1",
      isSubtask: true,
      tool: "Bash",
      status: "completed",
      args: { command: "secret-command", token: "secret-token" },
      output: "secret-output",
    } satisfies SandboxEvent;
    await h.processor.processSandboxEvent(event);

    const expected = {
      event_type: "tool_call",
      sandbox_id: "sb-1",
      message_id: "msg-1",
      call_id: "call-1",
      task_call_id: "parent-1",
      child_session_id: "child-1",
      is_subtask: true,
      tool: "Bash",
      status: "completed",
    };
    expect(h.log.info).toHaveBeenCalledWith("sandbox.event.received", expected);
    expect(h.log.info).toHaveBeenCalledWith("sandbox.event.processed", {
      ...expected,
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain("secret-");
    expect(h.streaming.handleToolCall).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ messageId: "msg-1" })
    );
  });

  it("uses resolved message attribution and bounds oversized metadata", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "fallback-message" });
    await h.processor.processSandboxEvent({
      type: "snapshot_ready",
      sandboxId: "s".repeat(1000),
      timestamp: 1000,
    });
    expect(h.log.info).toHaveBeenCalledWith("sandbox.event.received", {
      event_type: "snapshot_ready",
      sandbox_id: "s".repeat(256),
      message_id: null,
      metadata_truncated: true,
    });
    expect(h.log.info).toHaveBeenCalledWith("sandbox.event.processed", {
      event_type: "snapshot_ready",
      sandbox_id: "s".repeat(256),
      message_id: "fallback-message",
      metadata_truncated: true,
      duration_ms: expect.any(Number),
    });
  });

  it.each([
    {
      event: {
        type: "snapshot_ready",
        sandboxId: "sb-1",
        timestamp: 1000,
        ackId: "ack-1",
      } satisfies SandboxEvent,
      messageId: null,
    },
    {
      event: {
        type: "error",
        sandboxId: "sb-1",
        timestamp: 1000,
        ackId: "ack-1",
        messageId: "msg-1",
        error: "secret-event-detail",
      } satisfies SandboxEvent,
      messageId: "msg-1",
    },
  ])("logs receipt and attribution failure for $event.type", async ({ event, messageId }) => {
    const h = createProcessor();
    const failure = new TypeError("secret-persisted-row-detail");
    h.repository.getProcessingMessage.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(h.processor.processSandboxEvent(event)).rejects.toBe(failure);

    const expected = {
      event_type: event.type,
      sandbox_id: "sb-1",
      message_id: messageId,
      ack_id: "ack-1",
    };
    expect(h.log.info).toHaveBeenCalledWith("sandbox.event.received", expected);
    expect(h.log.info.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.getProcessingMessage.mock.invocationCallOrder[0]
    );
    expect(h.log.error).toHaveBeenCalledWith("sandbox.event.processing_failed", {
      ...expected,
      error_type: "TypeError",
      duration_ms: expect.any(Number),
    });
    expect(h.log.info).not.toHaveBeenCalledWith("sandbox.event.processed", expect.anything());
    expect(JSON.stringify([h.log.info.mock.calls, h.log.error.mock.calls])).not.toContain(
      "secret-"
    );
    expect(h.streaming.recordTimelineEvent).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["token", "heartbeat"] as const)("keeps %s diagnostics at DEBUG", async (type) => {
    const h = createProcessor();
    const event =
      type === "token"
        ? { type, sandboxId: "sb-1", timestamp: 1000, messageId: "msg-1", content: "secret-text" }
        : { type, sandboxId: "sb-1", timestamp: 1000 };
    await h.processor.processSandboxEvent(event);
    expect(h.log.debug).toHaveBeenCalledWith(
      "sandbox.event.received",
      expect.objectContaining({ event_type: type })
    );
    expect(h.log.debug).toHaveBeenCalledWith(
      "sandbox.event.processed",
      expect.objectContaining({ event_type: type })
    );
    expect(h.log.info).not.toHaveBeenCalled();
    expect(JSON.stringify(h.log.debug.mock.calls)).not.toContain("secret-text");
  });

  it("logs processing failure without leaking the error or acknowledging the event", async () => {
    const h = createProcessor();
    const failure = new TypeError("secret-error-detail");
    h.shutdown.generationReady.mockImplementation(() => {
      throw failure;
    });
    await expect(
      h.processor.processSandboxEvent({
        type: "sandbox_generation_ready",
        sandboxId: "sb-1",
        timestamp: 1000,
        generation: { sandboxId: "sb-1", createdAt: 4000 },
        ackId: "ack-1",
      })
    ).rejects.toBe(failure);
    expect(h.log.error).toHaveBeenCalledWith("sandbox.event.processing_failed", {
      event_type: "sandbox_generation_ready",
      sandbox_id: "sb-1",
      message_id: null,
      ack_id: "ack-1",
      error_type: "TypeError",
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(h.log.error.mock.calls)).not.toContain("secret-error-detail");
    expect(h.log.info).not.toHaveBeenCalledWith("sandbox.event.processed", expect.anything());
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["sent", "send_failed", "no_socket", "missing_id"] as const)(
    "logs ACK outcome %s only after processing",
    async (outcome) => {
      const h = createProcessor();
      if (outcome === "no_socket") h.wsManager.getSandboxSocket.mockReturnValue(null);
      h.send.mockReturnValue(outcome !== "send_failed");
      await h.processor.processSandboxEvent({
        type: "snapshot_ready",
        sandboxId: "sb-1",
        timestamp: 1000,
        ...(outcome === "missing_id" ? {} : { ackId: "ack-1" }),
      });
      const method = outcome === "sent" || outcome === "missing_id" ? h.log.info : h.log.warn;
      expect(method).toHaveBeenCalledWith(
        "sandbox.event.ack",
        expect.objectContaining({ outcome, event_type: "snapshot_ready" })
      );
      if (outcome === "sent" || outcome === "send_failed") {
        expect(h.send).toHaveBeenCalledOnce();
        expect(h.log.info.mock.invocationCallOrder[1]).toBeLessThan(
          h.send.mock.invocationCallOrder[0]
        );
      } else {
        expect(h.send).not.toHaveBeenCalled();
      }
      if (outcome === "missing_id") {
        expect(h.log.debug).not.toHaveBeenCalledWith("sandbox.event.ack", expect.anything());
      }
    }
  );
});
