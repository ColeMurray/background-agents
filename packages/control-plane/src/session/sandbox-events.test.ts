import { describe, expect, it, vi } from "vitest";
import { SessionSandboxEventProcessor } from "./sandbox-events";
import type { GitPushSpec } from "../source-control";
import type { SandboxEvent, ServerMessage } from "../types";

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
    getProcessingMessage,
    upsertTokenEvent: vi.fn(),
    createArtifact: vi.fn(),
    createEvent: vi.fn(),
    addSessionCost: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
    // The real repository stops reporting a processing message once it is
    // completed; the processing_status broadcast derives from that.
    updateMessageCompletion: vi.fn(() => {
      getProcessingMessage.mockReturnValue(null);
    }),
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
  const messenger = { broadcast, sendToSandbox: vi.fn(() => true) };
  const diffService = { pinBaselines: vi.fn() };
  const triggerSnapshot = vi.fn(async (_reason: string) => {});
  const reconcileSessionStatusAfterExecution = vi.fn(async (_success: boolean) => {});
  const scheduleInactivityCheck = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const updateLastActivity = vi.fn();
  const applySessionTitleUpdate = vi.fn((title: string) => ({ ok: true as const, title }));
  const waitUntil = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  const processor = new SessionSandboxEventProcessor(
    { waitUntil } as unknown as DurableObjectState,
    () => log,
    repository as never,
    callbackService as never,
    wsManager as never,
    messenger as never,
    diffService as never,
    applySessionTitleUpdate,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    updateLastActivity,
    scheduleInactivityCheck,
    processMessageQueue
  );

  return {
    processor,
    repository,
    wsManager,
    callbackService,
    broadcast,
    diffService,
    triggerSnapshot,
    reconcileSessionStatusAfterExecution,
    scheduleInactivityCheck,
    processMessageQueue,
    updateLastActivity,
    applySessionTitleUpdate,
    waitUntil,
  };
}

describe("SessionSandboxEventProcessor", () => {
  it("releases the next prompt without waiting for diff work", async () => {
    const h = createProcessor();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

    await h.processor.processSandboxEvent({
      type: "execution_complete",
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 2000,
    });

    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(true);
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
    expect(h.repository.createEvent).not.toHaveBeenCalled();
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

    expect(h.repository.createArtifact).toHaveBeenCalledWith({
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
    expect(h.repository.createEvent).toHaveBeenCalledWith({
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
    expect(h.repository.createEvent).not.toHaveBeenCalled();
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
    expect(h.repository.createEvent).not.toHaveBeenCalled();
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
    expect(h.repository.createEvent).not.toHaveBeenCalled();
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

    const pushPromise = h.processor.pushBranchToRemote(
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

  describe("push resolver keying", () => {
    function connectSandbox(h: ReturnType<typeof createProcessor>) {
      const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
      h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
      return sandboxWs;
    }

    it("settles the matching push when two repos push the same branch name", async () => {
      const h = createProcessor();
      connectSandbox(h);

      const webPush = h.processor.pushBranchToRemote(
        createPushSpec("acme", "web", "open-inspect/session-1")
      );
      const backendPush = h.processor.pushBranchToRemote(
        createPushSpec("acme", "backend", "open-inspect/session-1")
      );

      await h.processor.processSandboxEvent({
        type: "push_error",
        branchName: "open-inspect/session-1",
        repoOwner: "acme",
        repoName: "backend",
        error: "remote rejected",
        timestamp: 1000,
      });
      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "open-inspect/session-1",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });

      await expect(webPush).resolves.toEqual({ success: true });
      await expect(backendPush).resolves.toEqual({
        success: false,
        error: expect.stringContaining("remote rejected"),
      });
    });

    it("settles the sole pending push on a terminal event without repo identity", async () => {
      const h = createProcessor();
      connectSandbox(h);

      const pushPromise = h.processor.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // Legacy single-repo runtimes echo no repo identity.
      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 1000,
      });

      await expect(pushPromise).resolves.toEqual({ success: true });
    });

    it("rejects the sole pending push on a branch-less push_error", async () => {
      const h = createProcessor();
      connectSandbox(h);

      const pushPromise = h.processor.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // The bridge's "no repository found" path emits push_error with no
      // branchName at all; it must reject the pending push instead of
      // leaking it to the 360 s timeout.
      await h.processor.processSandboxEvent({
        type: "push_error",
        error: "No repository found for push",
        timestamp: 1000,
      });

      await expect(pushPromise).resolves.toEqual({
        success: false,
        error: expect.stringContaining("No repository found for push"),
      });
    });

    it("drops a fully identified event that mismatches the sole pending push", async () => {
      const h = createProcessor();
      connectSandbox(h);

      const pushPromise = h.processor.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // A stale event for a different repo must not settle the pending push
      // just because it is the only one in flight.
      await h.processor.processSandboxEvent({
        type: "push_error",
        branchName: "feature/test",
        repoOwner: "acme",
        repoName: "backend",
        error: "remote rejected",
        timestamp: 1000,
      });

      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "feature/test",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });

      await expect(pushPromise).resolves.toEqual({ success: true });
    });

    it("drops an identity-less terminal event when several pushes are pending", async () => {
      const h = createProcessor();
      connectSandbox(h);

      const webPush = h.processor.pushBranchToRemote(createPushSpec("acme", "web", "feature/a"));
      const backendPush = h.processor.pushBranchToRemote(
        createPushSpec("acme", "backend", "feature/b")
      );

      await h.processor.processSandboxEvent({
        type: "push_error",
        error: "ambiguous",
        timestamp: 1000,
      });

      // Neither push settles from the ambiguous event; identified events do.
      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "feature/a",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });
      await h.processor.processSandboxEvent({
        type: "push_complete",
        branchName: "feature/b",
        repoOwner: "acme",
        repoName: "backend",
        timestamp: 1002,
      });

      await expect(webPush).resolves.toEqual({ success: true });
      await expect(backendPush).resolves.toEqual({ success: true });
    });
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

    it("does not reset activity timer on heartbeat", async () => {
      const h = createProcessor();
      await h.processor.processSandboxEvent({
        type: "heartbeat",
        sandboxId: "sb-1",
        status: "ready",
        timestamp: 1000,
      });

      expect(h.updateLastActivity).not.toHaveBeenCalled();
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
      h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

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
      h.repository.getMessageTimestamps.mockReturnValue({ created_at: 1000, started_at: 1100 });

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

    it("sends ACK on already_stopped path for execution_complete", async () => {
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
