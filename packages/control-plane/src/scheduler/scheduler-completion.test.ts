import { describe, expect, it, vi } from "vitest";
import type { EnrichedRunRow } from "../db/automation-store";
import { createLogger } from "../logger";
import type { AutomationRunCompletion } from "./contracts";
import { Scheduler, type SchedulerDeps } from "./scheduler";

const nowMs = 1_000;
const run: EnrichedRunRow = {
  id: "run-1",
  automation_id: "auto-1",
  invocation_id: "inv-1",
  session_id: "sess-1",
  status: "running",
  skip_reason: null,
  failure_reason: null,
  scheduled_at: 0,
  started_at: 0,
  completed_at: null,
  execution_deadline_at: null,
  created_at: 0,
  repo_owner: null,
  repo_name: null,
  repo_id: null,
  base_branch: null,
  environment_id: null,
  first_prompt_pending: 1,
  session_title: null,
  artifact_summary: null,
};
const completion: AutomationRunCompletion = {
  automationId: run.automation_id,
  runId: run.id,
  sessionId: "sess-1",
  messageId: "msg-1",
  success: true,
};

function harness() {
  type Store = SchedulerDeps["store"];
  const deps = {
    store: {
      getRunById: vi.fn<Store["getRunById"]>().mockResolvedValue(run),
      markRunFirstPromptQueued: vi
        .fn<Store["markRunFirstPromptQueued"]>()
        .mockResolvedValue(undefined),
      updateRun: vi.fn<Store["updateRun"]>().mockResolvedValue(true),
      completeTimedOutRun: vi.fn<Store["completeTimedOutRun"]>().mockResolvedValue(false),
      getById: vi.fn<Store["getById"]>(),
      getOverdueAutomations: vi.fn<Store["getOverdueAutomations"]>(),
      getRepositoriesForAutomationIds: vi.fn<Store["getRepositoriesForAutomationIds"]>(),
      getEnvironmentsForAutomationIds: vi.fn<Store["getEnvironmentsForAutomationIds"]>(),
      recordAuthorizationDenied: vi.fn<Store["recordAuthorizationDenied"]>(),
    },
    failures: {
      applyInvocationOutcome: vi
        .fn<SchedulerDeps["failures"]["applyInvocationOutcome"]>()
        .mockResolvedValue(undefined),
    },
    slack: {
      notifyCompletion: vi
        .fn<SchedulerDeps["slack"]["notifyCompletion"]>()
        .mockResolvedValue(undefined),
    },
    invocations: {
      start: vi.fn<SchedulerDeps["invocations"]["start"]>(),
      retryDue: vi.fn<SchedulerDeps["invocations"]["retryDue"]>(),
    },
    recovery: { recoverRuns: vi.fn<SchedulerDeps["recovery"]["recoverRuns"]>() },
    events: { handle: vi.fn<SchedulerDeps["events"]["handle"]>() },
    continuity: { sweepHeldPrompts: vi.fn<SchedulerDeps["continuity"]["sweepHeldPrompts"]>() },
    clock: { now: () => nowMs },
    crypto: { generateId: vi.fn<SchedulerDeps["crypto"]["generateId"]>() },
    log: createLogger("scheduler-completion-test", {}, "error"),
  } satisfies SchedulerDeps;
  return { deps, scheduler: new Scheduler(deps) };
}

describe("Scheduler.runComplete", () => {
  it.each([
    { success: true, error: undefined, update: { status: "completed" } },
    {
      success: false,
      error: "Sandbox crashed",
      update: { status: "failed", failure_reason: "Sandbox crashed" },
    },
    {
      success: false,
      error: undefined,
      update: { status: "failed", failure_reason: "Unknown error" },
    },
  ])(
    "records $update.status before accounting and publication: $error",
    async ({ success, error, update }) => {
      const { deps, scheduler } = harness();
      const body = { ...completion, success, error };

      await expect(scheduler.runComplete(body)).resolves.toBeUndefined();

      expect(deps.store.getRunById).toHaveBeenCalledExactlyOnceWith("auto-1", "run-1");
      expect(deps.store.markRunFirstPromptQueued).toHaveBeenCalledExactlyOnceWith("run-1");
      expect(deps.store.updateRun).toHaveBeenCalledExactlyOnceWith("run-1", {
        ...update,
        completed_at: nowMs,
      });
      expect(deps.store.completeTimedOutRun).not.toHaveBeenCalled();
      expect(deps.failures.applyInvocationOutcome).toHaveBeenCalledExactlyOnceWith(
        "auto-1",
        "inv-1"
      );
      expect(deps.slack.notifyCompletion).toHaveBeenCalledExactlyOnceWith(run, body);
      expect(deps.store.markRunFirstPromptQueued.mock.invocationCallOrder[0]).toBeLessThan(
        deps.store.updateRun.mock.invocationCallOrder[0]!
      );
      expect(deps.store.updateRun.mock.invocationCallOrder[0]).toBeLessThan(
        deps.failures.applyInvocationOutcome.mock.invocationCallOrder[0]!
      );
      expect(deps.failures.applyInvocationOutcome.mock.invocationCallOrder[0]).toBeLessThan(
        deps.slack.notifyCompletion.mock.invocationCallOrder[0]!
      );
    }
  );

  it("ignores a missing run without writes, accounting, or publication", async () => {
    const { deps, scheduler } = harness();
    deps.store.getRunById.mockResolvedValue(null);

    await expect(scheduler.runComplete(completion)).resolves.toBeUndefined();

    expect(deps.store.markRunFirstPromptQueued).not.toHaveBeenCalled();
    expect(deps.store.updateRun).not.toHaveBeenCalled();
    expect(deps.store.completeTimedOutRun).not.toHaveBeenCalled();
    expect(deps.failures.applyInvocationOutcome).not.toHaveBeenCalled();
    expect(deps.slack.notifyCompletion).not.toHaveBeenCalled();
  });

  it.each([true, false])("ignores a terminal duplicate (success: %s)", async (success) => {
    const { deps, scheduler } = harness();
    deps.store.getRunById.mockResolvedValue({ ...run, status: "completed", completed_at: nowMs });
    deps.store.updateRun.mockResolvedValue(false);

    await expect(scheduler.runComplete({ ...completion, success })).resolves.toBeUndefined();

    expect(deps.store.markRunFirstPromptQueued).toHaveBeenCalledExactlyOnceWith("run-1");
    if (success) {
      expect(deps.store.completeTimedOutRun).toHaveBeenCalledExactlyOnceWith("run-1", nowMs);
    } else {
      expect(deps.store.completeTimedOutRun).not.toHaveBeenCalled();
    }
    expect(deps.failures.applyInvocationOutcome).not.toHaveBeenCalled();
    expect(deps.slack.notifyCompletion).not.toHaveBeenCalled();
  });

  it("publishes a late timeout correction without changing invocation accounting", async () => {
    const { deps, scheduler } = harness();
    const timedOutRun = { ...run, status: "failed" as const, failure_reason: "execution_timeout" };
    deps.store.getRunById.mockResolvedValue(timedOutRun);
    deps.store.updateRun.mockResolvedValue(false);
    deps.store.completeTimedOutRun.mockResolvedValue(true);

    await scheduler.runComplete(completion);

    expect(deps.store.completeTimedOutRun).toHaveBeenCalledExactlyOnceWith("run-1", nowMs);
    expect(deps.failures.applyInvocationOutcome).not.toHaveBeenCalled();
    expect(deps.slack.notifyCompletion).toHaveBeenCalledExactlyOnceWith(timedOutRun, completion);
  });

  it("propagates a run update error without accounting or publication", async () => {
    const { deps, scheduler } = harness();
    const error = new Error("D1 timeout");
    deps.store.updateRun.mockRejectedValue(error);

    await expect(scheduler.runComplete(completion)).rejects.toBe(error);

    expect(deps.failures.applyInvocationOutcome).not.toHaveBeenCalled();
    expect(deps.slack.notifyCompletion).not.toHaveBeenCalled();
  });

  it("propagates an accounting error without publishing completion", async () => {
    const { deps, scheduler } = harness();
    const error = new Error("Counter write failed");
    deps.failures.applyInvocationOutcome.mockRejectedValue(error);

    await expect(scheduler.runComplete(completion)).rejects.toBe(error);

    expect(deps.store.updateRun).toHaveBeenCalledOnce();
    expect(deps.slack.notifyCompletion).not.toHaveBeenCalled();
  });
});
