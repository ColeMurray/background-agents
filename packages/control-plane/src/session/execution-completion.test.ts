import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { CallbackNotificationService } from "./callback-notification-service";
import {
  SessionExecutionCompletionService,
  type SessionExecutionCompletion,
} from "./execution-completion";
import type { SessionMessenger } from "./messenger";
import type { SessionRepository } from "./repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionTerminalMessageProjection } from "./terminal-message-projection";

const COMPLETED_AT = 2_000;

function createHarness(): {
  completion: SessionExecutionCompletion;
  repository: Record<string, ReturnType<typeof vi.fn>>;
  projection: { recordTerminalMessage: ReturnType<typeof vi.fn> };
  callbackService: { notifyComplete: ReturnType<typeof vi.fn> };
  statusService: { reconcileAfterExecution: ReturnType<typeof vi.fn> };
  broadcast: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  log: Logger;
} {
  let processingMessage: { id: string } | null = { id: "msg-1" };
  const repository = {
    getProcessingMessage: vi.fn(() => processingMessage),
    getProcessingMessageWithCreatedAt: vi.fn(() => ({ id: "msg-1", created_at: 1_000 })),
    upsertExecutionCompleteEvent: vi.fn(),
    updateMessageCompletion: vi.fn(() => {
      processingMessage = null;
    }),
    getMessageTimestamps: vi.fn(() => ({ created_at: 1_000, started_at: 1_200 })),
  };
  const projection = { recordTerminalMessage: vi.fn(async () => {}) };
  const callbackService = { notifyComplete: vi.fn(async () => {}) };
  const statusService = { reconcileAfterExecution: vi.fn(async () => {}) };
  const broadcast = vi.fn();
  const waitUntil = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const completion = new SessionExecutionCompletionService(
    { waitUntil } as unknown as DurableObjectState,
    log,
    repository as unknown as SessionRepository,
    callbackService as unknown as CallbackNotificationService,
    { broadcast } as unknown as SessionMessenger,
    statusService as unknown as SessionStatusService,
    projection as unknown as SessionTerminalMessageProjection,
    () => COMPLETED_AT
  );

  return {
    completion,
    repository,
    projection,
    callbackService,
    statusService,
    broadcast,
    waitUntil,
    log,
  };
}

describe("SessionExecutionCompletionService", () => {
  it("awaits terminal projection before broadcasting a sandbox completion", async () => {
    const h = createHarness();
    let resolveProjection!: () => void;
    h.projection.recordTerminalMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProjection = resolve;
      })
    );
    const event = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: true,
      sandboxId: "sandbox-1",
      timestamp: 2,
    };

    const result = h.completion.completeFromSandbox(event, "msg-1", "msg-1", COMPLETED_AT);

    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      COMPLETED_AT
    );
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "completed",
      COMPLETED_AT
    );
    expect(h.broadcast).not.toHaveBeenCalled();

    resolveProjection();
    await result;

    expect(h.projection.recordTerminalMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: COMPLETED_AT,
    });
    expect(h.broadcast.mock.calls).toEqual([
      [{ type: "sandbox_event", event }],
      [{ type: "processing_status", isProcessing: false }],
    ]);
    expect(h.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith("msg-1", true, undefined);
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith(true);
  });

  it("ignores a sandbox completion that no longer owns the processing message", async () => {
    const h = createHarness();

    await h.completion.completeFromSandbox(
      {
        type: "execution_complete",
        messageId: "msg-old",
        success: false,
        sandboxId: "sandbox-1",
        timestamp: 2,
      },
      "msg-old",
      "msg-new",
      COMPLETED_AT
    );

    expect(h.repository.upsertExecutionCompleteEvent).not.toHaveBeenCalled();
    expect(h.repository.updateMessageCompletion).not.toHaveBeenCalled();
    expect(h.projection.recordTerminalMessage).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.callbackService.notifyComplete).not.toHaveBeenCalled();
    expect(h.statusService.reconcileAfterExecution).not.toHaveBeenCalled();
  });

  it("persists and reports a failed sandbox completion", async () => {
    const h = createHarness();
    const event = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: false,
      error: "Agent failed",
      sandboxId: "sandbox-1",
      timestamp: 2,
    };

    await h.completion.completeFromSandbox(event, "msg-1", "msg-1", COMPLETED_AT);

    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "failed",
      COMPLETED_AT
    );
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith("msg-1", false, "Agent failed");
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });

  it("finalizes a stopped message while projecting and notifying in the background", async () => {
    const h = createHarness();
    h.projection.recordTerminalMessage.mockReturnValue(new Promise<void>(() => {}));

    await h.completion.stopProcessingMessage();

    const event = expect.objectContaining({
      type: "execution_complete",
      messageId: "msg-1",
      success: false,
      error: "Execution was stopped",
      timestamp: 2,
    });
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "failed",
      COMPLETED_AT
    );
    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      COMPLETED_AT
    );
    expect(h.projection.recordTerminalMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: COMPLETED_AT,
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith(
      "msg-1",
      false,
      "Execution was stopped"
    );
    expect(h.waitUntil).toHaveBeenCalledTimes(2);
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });

  it("suppresses failed status reconciliation while cancellation takes ownership", async () => {
    const h = createHarness();

    await h.completion.stopProcessingMessage({ suppressStatusReconcile: true });

    expect(h.statusService.reconcileAfterExecution).not.toHaveBeenCalled();
  });

  it("finalizes a stuck message and reconciles failure without awaiting projection", async () => {
    const h = createHarness();
    h.projection.recordTerminalMessage.mockReturnValue(new Promise<void>(() => {}));

    await h.completion.failStuckProcessingMessage();

    expect(h.broadcast.mock.calls).toEqual([
      [
        {
          type: "sandbox_event",
          event: expect.objectContaining({
            type: "execution_complete",
            messageId: "msg-1",
            success: false,
            error: "Execution timed out (stuck processing)",
          }),
        },
      ],
      [{ type: "processing_status", isProcessing: false }],
    ]);
    expect(h.waitUntil).toHaveBeenCalledTimes(2);
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });
});
