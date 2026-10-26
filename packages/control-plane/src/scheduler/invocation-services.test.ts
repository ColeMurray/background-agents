import { describe, expect, it, vi } from "vitest";
import type {
  AutomationRow,
  AutomationRunRow,
  InvocationRunAggregate,
} from "../db/automation-store";
import { createLogger } from "../logger";
import { AutomationFailureService } from "./failure-service";
import {
  AutomationInvocationService,
  type AutomationInvocationServiceDeps,
} from "./invocation-service";
import { AutomationRecoveryService, type AutomationRecoveryServiceDeps } from "./recovery-service";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import { DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS } from "@open-inspect/shared/types/automations";

const automation: AutomationRow = {
  id: "auto-1",
  name: "Daily sync",
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_once_at: null,
  schedule_tz: "UTC",
  harness: "codex",
  model: "openai/gpt-5.4",
  reasoning_effort: null,
  enabled: 1,
  max_concurrent_runs: DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  next_run_at: 100,
  consecutive_failures: 0,
  created_by: "author-1",
  user_id: "user-1",
  owner_team_id: null,
  max_retries: 2,
  created_at: 0,
  updated_at: 0,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};
function run(overrides: Partial<AutomationRunRow> = {}): AutomationRunRow {
  return {
    id: "run-1",
    automation_id: automation.id,
    invocation_id: "inv-1",
    status: "retrying",
    session_id: null,
    skip_reason: null,
    failure_reason: null,
    scheduled_at: 0,
    started_at: null,
    completed_at: null,
    execution_deadline_at: null,
    created_at: 0,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    environment_id: null,
    first_prompt_pending: 0,
    attempt: 1,
    ...overrides,
  };
}
const log = createLogger("invocation-service-test", {}, "error");

function failureHarness(overrides: Partial<InvocationRunAggregate> = {}) {
  const store = {
    getInvocationRunAggregate: vi.fn().mockResolvedValue({
      total: 1,
      active: 0,
      retrying: 0,
      failed: 1,
      completed: 0,
      skipped: 0,
      lastCompletedAt: null,
      ...overrides,
    }),
    tryMarkInvocationFailureCounted: vi.fn().mockResolvedValue(true),
    incrementConsecutiveFailures: vi.fn().mockResolvedValue(5),
    autoPause: vi.fn().mockResolvedValue(undefined),
    disableSettledOneShots: vi.fn().mockResolvedValue(undefined),
    resetConsecutiveFailures: vi.fn().mockResolvedValue(undefined),
  };
  return { store, service: new AutomationFailureService(store, log) };
}

describe("AutomationFailureService", () => {
  it.each([
    { total: 0, failed: 0 },
    { total: 2, failed: 1, retrying: 1 },
    { total: 2, active: 1, failed: 0, completed: 1 },
    { total: 2, failed: 0, completed: 1 }, // An unauthorized sibling is not a success.
  ])("does not count or reset an unsettled/unsuccessful invocation: %j", async (aggregate) => {
    const { store, service } = failureHarness(aggregate);
    await service.applyInvocationOutcome("auto-1", "inv-1");
    expect(store.tryMarkInvocationFailureCounted).not.toHaveBeenCalled();
    expect(store.resetConsecutiveFailures).not.toHaveBeenCalled();
  });

  it("only increments and pauses when the failure claim wins", async () => {
    const { store, service } = failureHarness();
    store.tryMarkInvocationFailureCounted.mockResolvedValueOnce(false);
    await service.applyInvocationOutcome("auto-1", "inv-1");
    expect(store.incrementConsecutiveFailures).not.toHaveBeenCalled();
    await service.applyInvocationOutcome("auto-1", "inv-1");
    expect(store.incrementConsecutiveFailures).toHaveBeenCalledExactlyOnceWith("auto-1");
    expect(store.autoPause).toHaveBeenCalledExactlyOnceWith("auto-1");
  });

  it("does not reset or recount a partial failure when the last sibling completes", async () => {
    const { store, service } = failureHarness({ total: 2, failed: 1, completed: 1 });
    store.tryMarkInvocationFailureCounted.mockResolvedValue(false);

    await service.applyInvocationOutcome("auto-1", "inv-1");

    expect(store.getInvocationRunAggregate).toHaveBeenCalledWith("inv-1");
    expect(store.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-1");
    expect(store.resetConsecutiveFailures).not.toHaveBeenCalled();
    expect(store.incrementConsecutiveFailures).not.toHaveBeenCalled();
  });

  it("resets only after all children complete successfully", async () => {
    const { store, service } = failureHarness({ total: 2, failed: 0, completed: 2 });
    await service.applyInvocationOutcome("auto-1", "inv-1");
    expect(store.resetConsecutiveFailures).toHaveBeenCalledWith("auto-1");
    expect(store.tryMarkInvocationFailureCounted).not.toHaveBeenCalled();
  });

  it("propagates a counter write failure after claiming so callers retain their error policy", async () => {
    const { store, service } = failureHarness();
    const error = new Error("counter write failed");
    store.incrementConsecutiveFailures.mockRejectedValue(error);
    await expect(service.applyInvocationOutcome("auto-1", "inv-1")).rejects.toBe(error);
    expect(store.tryMarkInvocationFailureCounted).toHaveBeenCalledWith("inv-1");
    expect(store.autoPause).not.toHaveBeenCalled();
  });
});

function invocationHarness() {
  let id = 0;
  const deps = {
    store: {
      getById: vi.fn().mockResolvedValue(automation),
      getRetriesToSettle: vi.fn().mockResolvedValue([run()]),
      claimRetry: vi
        .fn<AutomationInvocationServiceDeps["store"]["claimRetry"]>()
        .mockImplementation(async (row) => ({ ...row, status: "starting", attempt: 2 })),
      failWithdrawnRetry: vi.fn().mockResolvedValue(false),
      resolveCanonicalOwner: vi
        .fn<AutomationInvocationServiceDeps["store"]["resolveCanonicalOwner"]>()
        .mockImplementation(async (row) => row),
      getInvocationIdByTriggerKey: vi.fn().mockResolvedValue(null),
      countActiveInvocations: vi.fn().mockResolvedValue(0),
      getActiveRunForKey: vi.fn().mockResolvedValue(null),
      getRepositoriesForAutomation: vi.fn().mockResolvedValue([]),
      getEnvironmentsForAutomation: vi.fn().mockResolvedValue([]),
      insertInvocationGuarded: vi.fn().mockResolvedValue({ inserted: true }),
      insertSkippedInvocation: vi.fn().mockResolvedValue({ inserted: true }),
      advanceNextRunAt: vi.fn().mockResolvedValue(true),
      acceptFollowUpReceipt: vi.fn().mockResolvedValue(undefined),
    },
    teams: { getById: vi.fn().mockResolvedValue(null) },
    isAuthorized: vi.fn().mockResolvedValue(true),
    resolveRepositories: vi.fn().mockResolvedValue([]),
    admission: {
      resolveTeamTargets: vi.fn().mockResolvedValue({
        targets: new Map(),
        teamGrantsVersion: { teamId: "team-1", version: 7 },
      }),
      resolveProviderAuth: vi.fn().mockResolvedValue({ providerAuth: [] }),
    },
    attribution: { resolve: vi.fn().mockResolvedValue(null) },
    launcher: {
      launch: vi
        .fn<AutomationInvocationServiceDeps["launcher"]["launch"]>()
        .mockImplementation(async (_automation, child) => {
          child.status = "running";
        }),
      recordFailure: vi
        .fn<AutomationInvocationServiceDeps["launcher"]["recordFailure"]>()
        .mockImplementation(async (child) => {
          child.status = "unauthorized";
        }),
    },
    failures: { applyInvocationOutcome: vi.fn().mockResolvedValue(undefined) },
    clock: { now: () => 1_000 },
    crypto: { generateId: () => `id-${++id}` },
    log,
  } satisfies AutomationInvocationServiceDeps;
  return { deps, service: new AutomationInvocationService(deps) };
}

describe("AutomationInvocationService", () => {
  it("accepts the receipt after insertion and continues launch when receipt repair fails", async () => {
    const { deps, service } = invocationHarness();
    deps.store.acceptFollowUpReceipt.mockRejectedValue(new Error("receipt write failed"));
    const instructions = vi.fn().mockResolvedValue("event prompt");
    const result = await service.start({
      automation,
      source: "event",
      invocationId: "inv-1",
      triggerKey: "webhook:1",
      webhookFollowUpClaimId: "claim-1",
      instructionsOverrideFactory: instructions,
    });
    expect(result).toMatchObject({ outcome: "started", invocationId: "inv-1", launched: 1 });
    expect(deps.store.acceptFollowUpReceipt).toHaveBeenCalledWith(
      automation.id,
      "webhook:1",
      "claim-1",
      "inv-1",
      1_000
    );
    const order = [
      deps.admission.resolveProviderAuth,
      deps.store.insertInvocationGuarded,
      deps.store.acceptFollowUpReceipt,
      deps.attribution.resolve,
      instructions,
      deps.launcher.launch,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order.every((call) => call !== undefined)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves a cron slot due when grants change before guarded insertion", async () => {
    const { deps, service } = invocationHarness();
    deps.teams.getById
      .mockResolvedValueOnce({ id: "team-1", grantsVersion: 7 })
      .mockResolvedValueOnce({ id: "team-1", grantsVersion: 8 });
    deps.store.insertInvocationGuarded.mockResolvedValue({ inserted: false });
    const result = await service.start({
      automation: { ...automation, owner_team_id: "team-1" },
      source: "schedule",
      scheduledAt: 100,
      advanceToNextRunAt: 200,
    });
    expect(result).toEqual({ outcome: "blocked", reason: "team_grants_changed" });
    expect(deps.store.insertInvocationGuarded).toHaveBeenCalledWith(
      expect.objectContaining({
        teamGrantsVersion: { teamId: "team-1", version: 7 },
        advanceSchedule: { fromSlot: 100, nextRunAt: 200 },
      })
    );
    expect(deps.store.insertSkippedInvocation).not.toHaveBeenCalled();
    expect(deps.store.advanceNextRunAt).not.toHaveBeenCalled();
    expect(deps.attribution.resolve).not.toHaveBeenCalled();
    expect(deps.launcher.launch).not.toHaveBeenCalled();
  });

  it("deduplicates before resolving authority, providers, or lazy instructions", async () => {
    const { deps, service } = invocationHarness();
    deps.store.getInvocationIdByTriggerKey.mockResolvedValue("existing-invocation");
    const instructions = vi.fn();
    expect(
      await service.start({
        automation,
        source: "event",
        triggerKey: "delivery-1",
        instructionsOverrideFactory: instructions,
      })
    ).toEqual({ outcome: "deduplicated", invocationId: "existing-invocation" });
    expect(deps.isAuthorized).not.toHaveBeenCalled();
    expect(deps.admission.resolveProviderAuth).not.toHaveBeenCalled();
    expect(instructions).not.toHaveBeenCalled();
  });

  it("contains accounting failures after a failed child launch", async () => {
    const { deps, service } = invocationHarness();
    deps.launcher.launch.mockImplementation(async (_automation, child) => {
      child.status = "failed";
    });
    deps.failures.applyInvocationOutcome.mockRejectedValue(new Error("accounting unavailable"));
    await expect(service.start({ automation, source: "schedule" })).resolves.toMatchObject({
      outcome: "started",
      launched: 0,
    });
    expect(deps.failures.applyInvocationOutcome).toHaveBeenCalledExactlyOnceWith(
      automation.id,
      "id-1"
    );
  });
});

function recoveryHarness() {
  const deps = {
    store: {
      getOrphanedStartingRuns: vi.fn().mockResolvedValue([]),
      getRunsPastExecutionDeadline: vi.fn().mockResolvedValue([]),
      bulkFailStartingRuns: vi.fn().mockResolvedValue(undefined),
      bulkFailRunningRuns: vi.fn().mockResolvedValue(undefined),
      disableSettledOneShots: vi.fn().mockResolvedValue(undefined),
      getUncountedFailedInvocations: vi.fn().mockResolvedValue([]),
      getStaleFailureResetCandidates: vi.fn().mockResolvedValue([]),
    },
    failures: { applyInvocationOutcome: vi.fn().mockResolvedValue(undefined) },
    executionDeadlineMs: () => 10_000,
    clock: { now: () => 1_000 },
    log,
  } satisfies AutomationRecoveryServiceDeps;
  return { deps, service: new AutomationRecoveryService(deps) };
}

describe("AutomationInvocationService retries", () => {
  it("spends a claimed attempt after admission denial and records failure only after the claim", async () => {
    const { deps, service } = invocationHarness();
    deps.isAuthorized.mockResolvedValue(false);
    expect(await service.retryDue(500)).toBe(1);
    expect(deps.store.getRetriesToSettle).toHaveBeenCalledWith(500, 25);
    expect(deps.store.claimRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", attempt: 1 }),
      1_000,
      undefined
    );
    expect(deps.launcher.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2 }),
      expect.any(AutomationExecutionUnauthorizedError),
      true
    );
    expect(deps.store.claimRetry.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launcher.recordFailure.mock.invocationCallOrder[0]
    );
    expect(deps.failures.applyInvocationOutcome).toHaveBeenCalledWith("auto-1", "inv-1");
    expect(deps.launcher.launch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not record an attempt after a lost claim; withdrawn=%s",
    async (withdrawn) => {
      const { deps, service } = invocationHarness();
      deps.isAuthorized.mockResolvedValue(false);
      deps.store.claimRetry.mockResolvedValue(null);
      deps.store.failWithdrawnRetry.mockResolvedValue(withdrawn);
      expect(await service.retryDue(500)).toBe(0);
      expect(deps.launcher.recordFailure).not.toHaveBeenCalled();
      expect(deps.launcher.launch).not.toHaveBeenCalled();
      expect(deps.failures.applyInvocationOutcome).toHaveBeenCalledTimes(withdrawn ? 1 : 0);
    }
  );

  it("resolves fresh attribution and provider routing before claiming against the admitted grants version", async () => {
    const { deps, service } = invocationHarness();
    deps.store.getById.mockResolvedValue({ ...automation, owner_team_id: "team-1" });
    deps.teams.getById.mockResolvedValue({ id: "team-1", grantsVersion: 7 });
    expect(await service.retryDue(500)).toBe(1);
    expect(deps.store.claimRetry).toHaveBeenCalledWith(expect.anything(), 1_000, {
      teamId: "team-1",
      version: 7,
    });
    const order = [
      deps.admission.resolveTeamTargets,
      deps.attribution.resolve,
      deps.admission.resolveProviderAuth,
      deps.store.claimRetry,
      deps.launcher.launch,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order.every((call) => call !== undefined)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("counts a claimed launch failure even if accounting also fails", async () => {
    const { deps, service } = invocationHarness();
    deps.launcher.launch.mockImplementation(async (_automation, child) => {
      child.status = "failed";
    });
    deps.failures.applyInvocationOutcome.mockRejectedValue(new Error("D1 unavailable"));
    expect(await service.retryDue(500)).toBe(1);
  });
});

describe("AutomationRecoveryService", () => {
  it("recovers timed-out siblings and finalizes accounting when the orphan query fails", async () => {
    const { deps, service } = recoveryHarness();
    deps.store.getOrphanedStartingRuns.mockRejectedValue(new Error("orphan query unavailable"));
    deps.store.getRunsPastExecutionDeadline.mockResolvedValue([
      run({ id: "run-1" }),
      run({ id: "run-2" }),
    ]);
    await service.recoverRuns();
    expect(deps.store.bulkFailRunningRuns).toHaveBeenCalledWith(
      ["run-1", "run-2"],
      "execution_timeout",
      1_000,
      10_000
    );
    expect(deps.failures.applyInvocationOutcome).toHaveBeenCalledExactlyOnceWith("auto-1", "inv-1");
    expect(deps.store.getStaleFailureResetCandidates).toHaveBeenCalled();
  });

  it("runs the finalization sweep even when there are no recoverable runs", async () => {
    const { deps, service } = recoveryHarness();
    deps.store.getUncountedFailedInvocations.mockResolvedValue([
      { automation_id: "auto-1", id: "missed-failure" },
    ]);
    deps.store.getStaleFailureResetCandidates.mockResolvedValue([
      { automation_id: "auto-2", invocation_id: "missed-reset" },
    ]);
    await service.recoverRuns();
    expect(deps.failures.applyInvocationOutcome.mock.calls).toEqual([
      ["auto-1", "missed-failure"],
      ["auto-2", "missed-reset"],
    ]);
  });
});
