import { describe, expect, it, vi } from "vitest";
import { createAlarmHandler, type AlarmHandlerDeps } from "./handler";

function makeDeps(
  overrides: Partial<Record<keyof AlarmHandlerDeps, unknown>> = {}
): AlarmHandlerDeps {
  return {
    repository: {
      getProcessingMessageWithStartedAt: vi.fn(() => null),
      getNextPendingMessage: vi.fn(() => null),
    },
    messageQueue: {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    },
    executionStop: {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    },
    lifecycleManager: { handleAlarm: vi.fn(async () => "no_action" as const) },
    terminalMessageProjection: { flushPending: vi.fn(async () => {}) },
    alarmScheduler: { schedule: vi.fn(async () => {}) },
    getExecutionTimeoutMs: () => 30_000,
    now: () => Date.now(),
    log: { warn: vi.fn() } as never,
    ...overrides,
  } as AlarmHandlerDeps;
}

describe("createAlarmHandler", () => {
  it("fails the pending boot prompt that was at the head before lifecycle work yielded", async () => {
    let pendingPrompt = { id: "msg-original" };
    const messageQueue = {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      repository: {
        getProcessingMessageWithStartedAt: vi.fn(() => null),
        getNextPendingMessage: vi.fn(() => pendingPrompt),
      },
      messageQueue,
      lifecycleManager: {
        handleAlarm: vi.fn(async () => {
          pendingPrompt = { id: "msg-new-head" };
          return { kind: "boot_budget_exceeded", reason: "Boot budget exceeded" };
        }),
      },
    });

    await createAlarmHandler(deps).handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
    expect(messageQueue.failPendingMessage).toHaveBeenCalledExactlyOnceWith(
      "msg-original",
      "Boot budget exceeded"
    );
  });

  it("re-drives work after a terminated sandbox without failing the pending prompt", async () => {
    const messageQueue = {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    };
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      repository: {
        getProcessingMessageWithStartedAt: vi.fn(() => null),
        getNextPendingMessage: vi.fn(() => ({ id: "msg-retry" })),
      },
      messageQueue,
      executionStop,
      lifecycleManager: { handleAlarm: vi.fn(async () => "sandbox_terminated" as const) },
    });

    await createAlarmHandler(deps).handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
    expect(messageQueue.failPendingMessage).not.toHaveBeenCalled();
  });

  it("still runs lifecycle recovery when terminal projection flush fails, then rethrows", async () => {
    const projectionError = new Error("projection write failed");
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    };
    const deps = makeDeps({
      terminalMessageProjection: {
        flushPending: vi.fn(async () => {
          throw projectionError;
        }),
      },
      executionStop,
      lifecycleManager: { handleAlarm: vi.fn(async () => "sandbox_terminated" as const) },
    });

    await expect(createAlarmHandler(deps).handle()).rejects.toThrow(projectionError);
    expect(executionStop.recoverStopConfirmationTimeout).toHaveBeenCalledOnce();
    expect(executionStop.resumeAfterSandboxTermination).toHaveBeenCalledOnce();
  });
});
