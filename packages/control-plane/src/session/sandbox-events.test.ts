import { describe, expect, it, vi } from "vitest";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import type { SandboxEvent, ServerMessage } from "../types";

function createProcessor() {
  const repository = {
    updateSandboxHeartbeat: vi.fn(),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    upsertTokenEvent: vi.fn(),
    createEvent: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
    updateMessageCompletion: vi.fn(),
    getMessageTimestamps: vi.fn(
      () => null as { created_at: number; started_at: number | null } | null
    ),
    updateSandboxGitSyncStatus: vi.fn(),
    updateSessionCurrentSha: vi.fn(),
  };

  const callbackService = {
    notifyToolCall: vi.fn(async () => {}),
    notifyComplete: vi.fn(async () => {}),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const triggerSnapshot = vi.fn(async (_reason: string) => {});
  const reconcileSessionStatusAfterExecution = vi.fn(async (_success: boolean) => {});
  const scheduleInactivityCheck = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const updateLastActivity = vi.fn();
  const getIsProcessing = vi.fn(() => false);
  const waitUntil = vi.fn();

  const processor = new SessionSandboxEventProcessor({
    ctx: { waitUntil } as unknown as DurableObjectState,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    repository: repository as never,
    callbackService: callbackService as never,
    wsManager: wsManager as never,
    broadcast,
    getIsProcessing,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    updateLastActivity,
    scheduleInactivityCheck,
    processMessageQueue,
  });

  return {
    processor,
    repository,
    wsManager,
    callbackService,
    broadcast,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    scheduleInactivityCheck,
    processMessageQueue,
    waitUntil,
  };
}

describe("SessionSandboxEventProcessor", () => {
  it("updates heartbeat without broadcasting", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "heartbeat",
      sandboxId: "sb-1",
      status: "ready",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.updateSandboxHeartbeat).toHaveBeenCalledWith(expect.any(Number));
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("persists token event and broadcasts it", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "token",
      content: "abc",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.upsertTokenEvent).toHaveBeenCalledWith("msg-1", event, expect.any(Number));
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("completes processing message and schedules post-completion work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      expect.any(Number)
    );
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "completed",
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(true);
    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.scheduleInactivityCheck).toHaveBeenCalledTimes(1);
    expect(h.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("resolves pending push when push_complete event arrives", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    const pushPromise = h.processor.pushBranchToRemote("feature/test", {
      remoteUrl: "https://token@example.com/repo.git",
      redactedRemoteUrl: "https://***@example.com/repo.git",
      refspec: "feature/test:feature/test",
      targetBranch: "feature/test",
      force: false,
    });

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "feature/test",
    });

    await expect(pushPromise).resolves.toEqual({ success: true });
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "push" })
    );
  });
});
