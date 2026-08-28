import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import { SessionSandboxEventProcessor } from "./processor";
import { SandboxArtifactEventHandler } from "./artifact.handler";
import { SandboxExecutionEventHandler } from "./execution.handler";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import { SandboxPushService } from "../sandbox-push-service";
import { SandboxStreamingEventHandler } from "./streaming.handler";
import type { GitPushSpec } from "../../source-control";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { CallbackNotificationService } from "../callback-notification-service";
import type { SessionDiffService } from "../diffs/service";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SandboxRepository } from "../sandbox-repository";
import type { ArtifactRepository } from "../artifact-repository";
import type { EventRepository } from "../event-repository";
import type { MessageRepository } from "../message-repository";
import type { SessionStatusService } from "../session-status-service";
import type { SessionWebSocketManager } from "../websocket-manager";

function createPushSpec(repoOwner: string, repoName: string, targetBranch: string): GitPushSpec {
  return {
    remoteUrl: `https://token@example.com/${repoOwner}/${repoName}.git`,
    redactedRemoteUrl: `https://***@example.com/${repoOwner}/${repoName}.git`,
    refspec: `HEAD:refs/heads/${targetBranch}`,
    targetBranch,
    repoOwner,
    repoName,
    force: false,
  };
}

function createProcessor() {
  const getProcessingMessage = vi.fn(() => null as { id: string } | null);
  const repository = {
    updateSandboxHeartbeat: vi.fn(),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    getProcessingMessage,
    addSessionCost: vi.fn(),
    recordMessageCompletion: vi.fn((event: { messageId: string }, completedAt: number) => {
      getProcessingMessage.mockReturnValue(null);
      return {
        messageId: event.messageId,
        messageCreatedAt: 1000,
        messageStartedAt: 1100,
        completedAt,
        status: "completed" as const,
      };
    }),
    clearMessageAwaitingStopConfirmation: vi.fn(),
    updateSandboxGitSyncStatus: vi.fn(),
    updateSessionCurrentSha: vi.fn(),
  };
  const eventRepository = {
    upsertTokenEvent: vi.fn(),
    createContextCompactionEvent: vi.fn(),
    upsertToolCallEvent: vi.fn(),
    createEvent: vi.fn(),
  } as unknown as EventRepository;
  const artifactRepository = { createArtifact: vi.fn() } as unknown as ArtifactRepository;

  const callbackService = {
    notifyToolCall: vi.fn(async () => {}),
    notifyComplete: vi.fn(async () => {}),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const diffService = { pinBaselines: vi.fn() };
  const triggerSnapshot = vi.fn(async (_reason: string) => {});
  const projectTerminalMessage = vi.fn(async () => {});
  const statusService = { reconcileAfterExecution: vi.fn(async (_success: boolean) => {}) };
  const scheduleInactivityCheck = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const broadcastPromptQueue = vi.fn();
  const updateLastActivity = vi.fn();
  const applySessionTitleUpdate = vi.fn((title: string) => ({ ok: true as const, title }));
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const backgroundTasks = createTestBackgroundTasks();

  // The real family composition, mirroring components.ts, so the suite keeps
  // pinning end-to-end processSandboxEvent behavior across the split.
  const pushService = new SandboxPushService(log, wsManager as unknown as SessionWebSocketManager);
  const processor = new SessionSandboxEventProcessor(
    log,
    repository as unknown as MessageRepository,
    wsManager as unknown as SessionWebSocketManager,
    new SandboxStreamingEventHandler(
      backgroundTasks,
      repository as unknown as SessionCoreRepository,
      eventRepository,
      callbackService as unknown as CallbackNotificationService,
      messenger,
      updateLastActivity
    ),
    new SandboxArtifactEventHandler(
      artifactRepository,
      eventRepository,
      messenger,
      updateLastActivity
    ),
    new SandboxExecutionEventHandler(
      backgroundTasks,
      log,
      repository as unknown as MessageRepository,
      callbackService as unknown as CallbackNotificationService,
      messenger,
      projectTerminalMessage,
      statusService as unknown as SessionStatusService,
      triggerSnapshot,
      updateLastActivity,
      scheduleInactivityCheck,
      processMessageQueue,
      broadcastPromptQueue
    ),
    new SandboxRuntimeEventHandler(
      repository as unknown as SessionCoreRepository,
      repository as unknown as SandboxRepository,
      eventRepository,
      messenger,
      diffService as unknown as SessionDiffService,
      applySessionTitleUpdate,
      updateLastActivity
    ),
    pushService
  );

  return {
    processor,
    pushService,
    artifactRepository,
    repository,
    eventRepository,
    wsManager,
    callbackService,
    broadcast,
    diffService,
    triggerSnapshot,
    projectTerminalMessage,
    statusService,
    scheduleInactivityCheck,
    processMessageQueue,
    broadcastPromptQueue,
    updateLastActivity,
    applySessionTitleUpdate,
    backgroundTasks,
    log,
  };
}

describe("SessionSandboxEventProcessor", () => {
  it("releases the next prompt without waiting for diff work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledOnce();
  });

  it("logs when the post-completion snapshot fails", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.triggerSnapshot.mockRejectedValue(new Error("snapshot backend down"));

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    await h.backgroundTasks.settle();
    // The failed snapshot is absorbed by the boundary, not thrown at the caller.
    expect(h.backgroundTasks.failures).toEqual([expect.any(Error)]);
  });

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

  it("applies session_title without storing a timeline event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "session_title",
      title: "Generated title",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.applySessionTitleUpdate).toHaveBeenCalledWith("Generated title", {
      onlyIfUnset: true,
    });
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });

  it("pins diff baselines on ready", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.diffService.pinBaselines).toHaveBeenCalledWith(event);
  });

  it("records the reported runtime version on ready", async () => {
    const h = createProcessor();

    await h.processor.processSandboxEvent({
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
      runtimeVersion: "v59-opencode-1-18-18",
    });

    expect(h.repository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(
      "v59-opencode-1-18-18"
    );
  });

  it("records a null runtime version when the sandbox reports none", async () => {
    const h = createProcessor();

    // A replacement sandbox that reports nothing must not inherit its
    // predecessor's version, or a snapshot it takes is stamped with a runtime
    // that never produced it. Spawn clears the column; this write keeps it
    // clear rather than filling it in.
    await h.processor.processSandboxEvent({
      type: "ready",
      sandboxId: "sb-1",
      timestamp: 1000,
    });

    expect(h.repository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(null);
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

    expect(h.eventRepository.upsertTokenEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("persists each context compaction marker and broadcasts it", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "context_compacted",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);
    await h.processor.processSandboxEvent({ ...event, timestamp: 1001 });

    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenCalledTimes(2);
    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenNthCalledWith(1, {
      id: expect.any(String),
      type: "context_compacted",
      data: JSON.stringify(event),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.eventRepository.createContextCompactionEvent).toHaveBeenNthCalledWith(2, {
      id: expect.any(String),
      type: "context_compacted",
      data: JSON.stringify({ ...event, timestamp: 1001 }),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, { type: "sandbox_event", event });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: { ...event, timestamp: 1001 },
    });
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });

  it("persists artifact events into artifacts and broadcasts both channels", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "artifact",
      artifactType: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: {
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      },
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.artifactRepository.createArtifact).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: JSON.stringify({
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 512,
      }),
      createdAt: expect.any(Number),
    });
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith({
      id: expect.any(String),
      type: "artifact",
      data: expect.any(String),
      messageId: "msg-1",
      createdAt: expect.any(Number),
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(1, {
      type: "artifact_created",
      artifact: {
        id: expect.any(String),
        type: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 512,
        },
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    });
    expect(h.broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "artifact",
        artifactType: "screenshot",
        messageId: "msg-1",
        sandboxId: "sb-1",
        url: "sessions/session-1/media/artifact-1.png",
      }),
    });
  });

  it("adds step_finish cost to session aggregate and broadcasts event", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: 0.0123,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).toHaveBeenCalledWith(0.0123, expect.any(Number));
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with NaN cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.NaN,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with negative cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: -0.05,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("does not add session cost for step_finish with Infinity cost", async () => {
    const h = createProcessor();
    const event: SandboxEvent = {
      type: "step_finish",
      messageId: "msg-1",
      sandboxId: "sb-1",
      timestamp: 1000,
      cost: Number.POSITIVE_INFINITY,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("completes processing message and schedules post-completion work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

    const event: SandboxEvent = {
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    };

    await h.processor.processSandboxEvent(event);

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      event,
      expect.any(Number),
      "processing"
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.broadcastPromptQueue).toHaveBeenCalledOnce();
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith("msg-1", true, undefined);
    expect(h.statusService.reconcileAfterExecution).toHaveBeenCalledWith(true);
    expect(h.repository.recordMessageCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      h.projectTerminalMessage.mock.invocationCallOrder[0]
    );
    expect(h.projectTerminalMessage.mock.invocationCallOrder[0]).toBeLessThan(
      h.broadcastPromptQueue.mock.invocationCallOrder[0]
    );
    expect(h.broadcastPromptQueue.mock.invocationCallOrder[0]).toBeLessThan(
      h.callbackService.notifyComplete.mock.invocationCallOrder[0]
    );
    expect(h.callbackService.notifyComplete.mock.invocationCallOrder[0]).toBeLessThan(
      h.statusService.reconcileAfterExecution.mock.invocationCallOrder[0]
    );
    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.scheduleInactivityCheck).toHaveBeenCalledTimes(1);
    expect(h.processMessageQueue).toHaveBeenCalledTimes(1);
    expect(h.backgroundTasks.submissions).not.toHaveLength(0);
  });

  it("waits for terminal projection before snapshot, queue drain, and acknowledgement", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
    let resolveCompletion!: () => void;
    h.projectTerminalMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      })
    );

    const processing = h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2,
      ackId: "ack-1",
    });

    expect(h.triggerSnapshot).not.toHaveBeenCalled();
    expect(h.processMessageQueue).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();

    resolveCompletion();
    await processing;

    expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "ack", ackId: "ack-1" });
  });

  it("delegates a late terminal event with no processing owner", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-current" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: false,
      sandboxId: "sb-1",
      timestamp: 2_000,
    });

    expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
    expect(h.repository.clearMessageAwaitingStopConfirmation).toHaveBeenCalledWith("msg-1");
  });

  it("delegates a failed sandbox completion", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-failed" });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-failed",
      success: false,
      error: "Agent failed",
      sandboxId: "sb-1",
      timestamp: 2_000,
    });

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg-failed", success: false }),
      expect.any(Number),
      "processing"
    );
  });

  it("resolves pending push when push_complete event arrives", async () => {
    const h = createProcessor();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    const pushPromise = h.pushService.pushBranchToRemote(
      createPushSpec("acme", "web", "feature/test")
    );

    await h.processor.processSandboxEvent({
      type: "push_complete",
      branchName: "feature/test",
      repoOwner: "acme",
      repoName: "web",
      timestamp: 1000,
    });

    await expect(pushPromise).resolves.toEqual({ success: true });
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "push" })
    );
  });

  describe("activity tracking for intermediate events", () => {
    it("resets activity timer on tool_call", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "tool_call",
        tool: "bash",
        args: { command: "ls" },
        callId: "call-1",
        status: "running",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
      expect(h.eventRepository.upsertToolCallEvent).toHaveBeenCalledWith(
        "msg-1",
        expect.objectContaining({ callId: "call-1", status: "running" }),
        expect.any(Number)
      );
    });

    it("notifies tool_call regardless of status (provider-agnostic)", async () => {
      // Anthropic lifecycle uses status="running"; OpenAI's Responses API may
      // only emit status="completed". Both should reach notifyToolCall so the
      // service-level dedup decides whether to fire.
      for (const status of ["running", "completed", "in_progress"]) {
        const h = createProcessor();
        await h.processor.processSandboxEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "ls" },
          callId: `call-${status}`,
          status,
          messageId: "msg-1",
          sandboxId: "sb-1",
          timestamp: 1000,
        });

        expect(h.callbackService.notifyToolCall).toHaveBeenCalledWith(
          "msg-1",
          expect.objectContaining({ type: "tool_call", status, callId: `call-${status}` })
        );
      }
    });

    it("resets activity timer on step_start", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_start",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("resets activity timer on step_finish", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("does not reset activity timer on heartbeat while idle", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "ready",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });

    it("resets activity timer on heartbeat while a message is processing", async () => {
      const h = createProcessor();
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "ready",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).toHaveBeenCalledWith(expect.any(Number));
    });

    it("does not reset activity timer on token", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
    });
  });

  describe("ACK mechanism", () => {
    it("sends ACK after execution_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
    });

    it("sends ACK for push_complete when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 2000,
        ackId: "push_complete:msg-2",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "push_complete:msg-2",
      });
    });

    it("sends ACK for error events when ackId is present", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "error",
        error: "something failed",
        messageId: "msg-3",
        sandboxId: "sb-1",
        timestamp: 3000,
        ackId: "error:msg-3",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "error:msg-3",
      });
    });

    it("does not send ACK when ackId is absent (backward compatibility)", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });

      const event: SandboxEvent = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
      };

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).not.toHaveBeenCalled();
    });

    it("ACKs duplicate completions while safely repeating lifecycle reconciliation", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      // No processing message — triggers the "already_stopped" branch
      h.repository.getProcessingMessage.mockReturnValue(null);

      const event = {
        type: "execution_complete",
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2000,
        ackId: "execution_complete:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, {
        type: "ack",
        ackId: "execution_complete:msg-1",
      });
      expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
      expect(h.triggerSnapshot).toHaveBeenCalledWith("execution_complete");
      expect(h.updateLastActivity).toHaveBeenCalledOnce();
      expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
      expect(h.processMessageQueue).toHaveBeenCalledOnce();
    });

    it("does not send ACK for non-critical events even with ackId", async () => {
      const h = createProcessor();
      const sandboxWs = {} as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

      const event = {
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1000,
        ackId: "token:msg-1",
      } as unknown as SandboxEvent;

      await h.processor.processSandboxEvent(event);

      // Token events return early before ACK logic
      expect(h.wsManager.send).not.toHaveBeenCalled();
    });
  });
});
