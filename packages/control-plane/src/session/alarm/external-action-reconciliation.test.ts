import { expect, it, vi } from "vitest";
import { createAlarmHandler } from "./handler";

it("composes external reconciliation and sandbox commands through one alarm scheduler", async () => {
  const recoverDue = vi.fn(async () => undefined);
  const schedule = vi.fn(async (_deadline: number) => undefined);
  const sandboxCommandDeadlines = vi.fn(async () => {
    await schedule(6_000);
  });
  const handler = createAlarmHandler({
    repository: {
      getProcessingMessageWithStartedAt: () => null,
      getNextPendingMessage: () => null,
    } as never,
    messageQueue: {
      failStuckProcessingMessage: vi.fn(),
      failPendingMessage: vi.fn(),
    },
    executionStop: {
      recoverStopConfirmationTimeout: vi.fn(),
      resumeAfterSandboxTermination: vi.fn(),
    },
    lifecycleManager: { handleAlarm: vi.fn(async () => "no_action" as const) },
    terminalMessageProjection: { flushPending: vi.fn() },
    alarmScheduler: { schedule } as never,
    externalActions: {
      recoverDue,
      nextDeadline: () => 7_000,
    },
    sandboxCommandDeadlines,
    getExecutionTimeoutMs: () => 60_000,
    now: () => 5_000,
    log: { warn: vi.fn() } as never,
  });

  await handler.handle();

  expect(recoverDue).toHaveBeenCalledOnce();
  expect(sandboxCommandDeadlines).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledWith(7_000);
  expect(schedule).toHaveBeenCalledWith(6_000);
});
