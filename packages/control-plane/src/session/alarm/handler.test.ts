import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import { createAlarmHandler } from "./handler";
import type { MessageRepository } from "../message-repository";
import { createEarliestAlarmScheduler } from "./scheduler";
import type { SandboxAlarmResult } from "../../sandbox/lifecycle/manager";

function createHandler() {
  const repository = {
    getProcessingMessageWithStartedAt: vi.fn(),
    getNextPendingMessage: vi.fn(() => null as { id: string } | null),
  };
  const messageQueue = {
    failStuckProcessingMessage: vi.fn<() => Promise<void>>().mockResolvedValue(),
    failPendingMessage: vi
      .fn<(messageId: string, reason: string) => Promise<void>>()
      .mockResolvedValue(),
  };
  const executionStop = {
    recoverStopConfirmationTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(),
    resumeAfterSandboxTermination: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const lifecycleManager = {
    handleAlarm: vi.fn<() => Promise<SandboxAlarmResult>>().mockResolvedValue("no_action"),
  };
  const terminalMessageProjection = {
    flushPending: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const alarmScheduler = {
    schedule: vi.fn<(timestamp: number) => Promise<void>>().mockResolvedValue(),
    cancel: vi.fn<() => Promise<void>>().mockResolvedValue(),
    current: vi.fn<() => Promise<number | null>>().mockResolvedValue(null),
  };
  const now = vi.fn(() => 2000);
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const handler = createAlarmHandler({
    repository: repository as unknown as MessageRepository,
    messageQueue,
    executionStop,
    lifecycleManager,
    terminalMessageProjection,
    alarmScheduler,
    getExecutionTimeoutMs: () => 1000,
    now,
    log,
  });

  return {
    handler,
    repository,
    messageQueue,
    executionStop,
    lifecycleManager,
    terminalMessageProjection,
    alarmScheduler,
    now,
    log,
  };
}

describe("createAlarmHandler", () => {
  it("fails the prompt a boot was for when the lifecycle gives up on the boot budget", async () => {
    const { handler, repository, messageQueue, executionStop, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    repository.getNextPendingMessage.mockReturnValue({ id: "msg-boot" });
    lifecycleManager.handleAlarm.mockResolvedValue({
      kind: "boot_budget_exceeded",
      reason: "Sandbox boot exceeded 30 minutes while running setup.sh for acme/api.",
    });

    await handler.handle();

    expect(messageQueue.failPendingMessage).toHaveBeenCalledWith(
      "msg-boot",
      "Sandbox boot exceeded 30 minutes while running setup.sh for acme/api."
    );
    // Not a termination: nothing re-drives the queue onto a replacement.
    expect(executionStop.resumeAfterSandboxTermination).not.toHaveBeenCalled();
  });

  it("fails the prompt that was waiting when the alarm fired, not whichever is head afterwards", async () => {
    // Lifecycle handling can yield on a provider stop; a cancel in that gap
    // must not shift the failure onto the next user's prompt.
    const { handler, repository, messageQueue, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    repository.getNextPendingMessage.mockReturnValue({ id: "msg-boot" });
    lifecycleManager.handleAlarm.mockImplementation(async () => {
      repository.getNextPendingMessage.mockReturnValue({ id: "msg-later" });
      return { kind: "boot_budget_exceeded", reason: "budget" };
    });

    await handler.handle();

    expect(messageQueue.failPendingMessage).toHaveBeenCalledWith("msg-boot", "budget");
    expect(messageQueue.failPendingMessage).not.toHaveBeenCalledWith("msg-later", "budget");
  });

  it("fails no prompt when none was pending at the alarm", async () => {
    const { handler, repository, messageQueue, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    repository.getNextPendingMessage.mockReturnValue(null);
    lifecycleManager.handleAlarm.mockResolvedValue({ kind: "boot_budget_exceeded", reason: "x" });

    await handler.handle();

    expect(messageQueue.failPendingMessage).not.toHaveBeenCalled();
  });

  it("does not fail a pending prompt for the other lifecycle outcomes", async () => {
    for (const result of ["no_action", "sandbox_failed", "sandbox_terminated"] as const) {
      const { handler, repository, messageQueue, lifecycleManager } = createHandler();
      repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
      repository.getNextPendingMessage.mockReturnValue({ id: "msg-boot" });
      lifecycleManager.handleAlarm.mockResolvedValue(result);

      await handler.handle();

      expect(messageQueue.failPendingMessage).not.toHaveBeenCalled();
    }
  });

  it("delegates to lifecycle manager when no processing message exists", async () => {
    const {
      handler,
      repository,
      messageQueue,
      executionStop,
      lifecycleManager,
      alarmScheduler,
      now,
    } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);

    await handler.handle();

    expect(now).not.toHaveBeenCalled();
    expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(messageQueue.failStuckProcessingMessage).not.toHaveBeenCalled();
    expect(executionStop.recoverStopConfirmationTimeout).toHaveBeenCalledOnce();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it("retries a deferred terminal message projection before anything else", async () => {
    const { handler, repository, executionStop, terminalMessageProjection } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);

    await handler.handle();

    expect(terminalMessageProjection.flushPending).toHaveBeenCalledOnce();
    expect(terminalMessageProjection.flushPending.mock.invocationCallOrder[0]).toBeLessThan(
      executionStop.recoverStopConfirmationTimeout.mock.invocationCallOrder[0]
    );
  });

  it("does not fail processing message when execution timeout is not reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, alarmScheduler, log } =
      createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 1500,
    });

    await handler.handle();

    expect(log.warn).not.toHaveBeenCalled();
    expect(messageQueue.failStuckProcessingMessage).not.toHaveBeenCalled();
    expect(alarmScheduler.schedule).toHaveBeenCalledWith(2500);
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it("completes lifecycle recovery before propagating a projection failure for retry", async () => {
    const {
      handler,
      repository,
      messageQueue,
      executionStop,
      lifecycleManager,
      terminalMessageProjection,
    } = createHandler();
    const error = new Error("Malformed pending terminal message projection row");
    terminalMessageProjection.flushPending.mockRejectedValue(error);
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 500,
    });
    lifecycleManager.handleAlarm.mockResolvedValue("sandbox_terminated");

    await expect(handler.handle()).rejects.toBe(error);

    expect(executionStop.recoverStopConfirmationTimeout).toHaveBeenCalledOnce();
    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledTimes(2);
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
  });

  it("keeps the execution deadline ahead of a later lifecycle check", async () => {
    let currentAlarm: number | null = null;
    const storage = {
      getAlarm: vi.fn(async () => currentAlarm),
      setAlarm: vi.fn(async (timestamp: number) => {
        currentAlarm = timestamp;
      }),
      deleteAlarm: vi.fn(async () => {
        currentAlarm = null;
      }),
    };
    const alarmScheduler = createEarliestAlarmScheduler(storage, {
      pending: vi.fn(() => null),
      earliest: vi.fn(() => null),
      cancelled: vi.fn(() => false),
      setPending: vi.fn(),
      setPendingEarliest: vi.fn(),
      activate: vi.fn(),
      clear: vi.fn(),
      beginDelivery: vi.fn(() => null),
      completeDelivery: vi.fn(),
    });
    const lifecycleManager = {
      handleAlarm: vi.fn(async () => {
        await alarmScheduler.schedule(5000);
        return "no_action" as const;
      }),
    };
    const repository = {
      getNextPendingMessage: vi.fn(() => null),
      getProcessingMessageWithStartedAt: vi.fn(() => ({
        id: "message-1",
        started_at: 1500,
      })),
    };
    const messageQueue = {
      failStuckProcessingMessage: vi.fn<() => Promise<void>>().mockResolvedValue(),
      failPendingMessage: vi
        .fn<(messageId: string, reason: string) => Promise<void>>()
        .mockResolvedValue(),
    };
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(),
      resumeAfterSandboxTermination: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };

    const handler = createAlarmHandler({
      repository: repository as unknown as MessageRepository,
      messageQueue,
      executionStop,
      lifecycleManager,
      terminalMessageProjection: { flushPending: vi.fn(async () => {}) },
      alarmScheduler,
      getExecutionTimeoutMs: () => 1000,
      now: () => 2000,
      log: createHandler().log,
    });

    await handler.handle();

    expect(currentAlarm).toBe(2500);
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm).toHaveBeenCalledWith(2500);
  });

  it("fails stuck processing message when execution timeout is reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, alarmScheduler, log } =
      createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 500,
    });

    await handler.handle();

    expect(log.warn).toHaveBeenCalledWith("Execution timeout: message stuck in processing", {
      event: "execution.timeout",
      message_id: "message-1",
      elapsed_ms: 1500,
      timeout_ms: 1000,
    });
    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledTimes(1);
    expect(alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it("fails stuck work without resuming after a connecting timeout", async () => {
    const { handler, repository, messageQueue, executionStop, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    lifecycleManager.handleAlarm.mockResolvedValue("sandbox_failed");

    await handler.handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).not.toHaveBeenCalled();
  });

  it("fails stuck work and resumes after lifecycle termination", async () => {
    const { handler, repository, messageQueue, executionStop, lifecycleManager } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);
    lifecycleManager.handleAlarm.mockResolvedValue("sandbox_terminated");

    await handler.handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
  });
});
