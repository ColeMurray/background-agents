import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { MessageRepository } from "../message-repository";
import type { SessionWebSocketManager } from "../websocket-manager";
import { SessionSandboxEventProcessor } from "./processor";

type ShutdownEvent = Extract<
  SandboxEvent,
  { type: "sandbox_generation_ready" | "preservation_prepared" }
>;

function createProcessor() {
  const sandboxSocket = {} as WebSocket;
  const send = vi.fn(() => true);
  const shutdown = {
    generationReady: vi.fn<(event: ShutdownEvent) => void>(),
    prepared: vi.fn<(event: ShutdownEvent) => void>(),
  };
  const processor = new SessionSandboxEventProcessor(
    { info: vi.fn(), debug: vi.fn() } as unknown as Logger,
    { getProcessingMessage: () => null } as unknown as MessageRepository,
    { getSandboxSocket: () => sandboxSocket, send } as unknown as SessionWebSocketManager,
    // Shutdown events must not depend on any other event-family handler.
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    shutdown
  );
  return { processor, sandboxSocket, send, shutdown };
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
