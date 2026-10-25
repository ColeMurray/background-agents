import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import {
  EXECUTION_TIMEOUT_FAILURE_REASON,
  type AutomationStore,
  type AutomationRunRow,
} from "../db/automation-store";
import type { Logger } from "../logger";
import { DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS } from "./launch-policy";
import type { AutomationFailureService } from "./failure-service";

/** Threshold for detecting orphaned "starting" runs (5 minutes). */
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/** Max runs to recover per sweep type per tick (backpressure). */
const RECOVERY_SWEEP_LIMIT = 50;

/**
 * How far back the finalization sweep scans invocations for missed failure
 * strikes or resets (the crash-after-last-callback window is seconds; a day
 * keeps the derived-status scan cheap while covering long outages).
 */
const INVOCATION_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AutomationRecoveryServiceDeps {
  store: Pick<
    AutomationStore,
    | "disableSettledOneShots"
    | "bulkFailRunningRuns"
    | "bulkFailStartingRuns"
    | "getOrphanedStartingRuns"
    | "getRunsPastExecutionDeadline"
    | "getStaleFailureResetCandidates"
    | "getUncountedFailedInvocations"
  >;
  failures: Pick<AutomationFailureService, "applyInvocationOutcome">;
  executionDeadlineMs(settings: SandboxSettings): number;
  clock: Pick<DateConstructor, "now">;
  log: Logger;
}

/** Repair abandoned runs and missed invocation accounting. */
export class AutomationRecoveryService {
  constructor(private readonly deps: AutomationRecoveryServiceDeps) {}

  // ─── Recovery sweep ──────────────────────────────────────────────────────

  async recoverRuns(): Promise<void> {
    const store = this.deps.store;
    const now = this.deps.clock.now();
    const [orphanedResult, timedOutResult] = await Promise.allSettled([
      store.getOrphanedStartingRuns(ORPHAN_THRESHOLD_MS, RECOVERY_SWEEP_LIMIT),
      // A run claimed by a worker that predates the deadline column carries
      // none; it is held to the deployment-default deadline instead.
      store.getRunsPastExecutionDeadline(
        now,
        this.deps.executionDeadlineMs(DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS),
        RECOVERY_SWEEP_LIMIT
      ),
    ]);

    const orphaned = orphanedResult.status === "fulfilled" ? orphanedResult.value : [];
    const timedOut = timedOutResult.status === "fulfilled" ? timedOutResult.value : [];

    if (orphanedResult.status === "rejected") {
      this.deps.log.error("Recovery sweep failed to query orphaned runs", {
        event: "scheduler.recovery.query_error",
        category: "orphaned",
        error:
          orphanedResult.reason instanceof Error
            ? orphanedResult.reason.message
            : String(orphanedResult.reason),
      });
    }

    if (timedOutResult.status === "rejected") {
      this.deps.log.error("Recovery sweep failed to query timed-out runs", {
        event: "scheduler.recovery.query_error",
        category: "timed_out",
        error:
          timedOutResult.reason instanceof Error
            ? timedOutResult.reason.message
            : String(timedOutResult.reason),
      });
    }

    if (orphaned.length === 0 && timedOut.length === 0) {
      await this.finalizationSweep();
      return;
    }

    for (const run of orphaned) {
      this.deps.log.warn("Recovering orphaned starting run", {
        event: "scheduler.recovery.orphaned",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }
    for (const run of timedOut) {
      this.deps.log.warn("Recovering timed-out running run", {
        event: "scheduler.recovery.timed_out",
        run_id: run.id,
        automation_id: run.automation_id,
        session_id: run.session_id,
        execution_deadline_at: run.execution_deadline_at,
      });
    }

    const recoveredRuns: AutomationRunRow[] = [];

    if (orphaned.length > 0) {
      try {
        await store.bulkFailStartingRuns(
          orphaned.map((r) => r.id),
          "session_creation_timeout",
          now,
          now - ORPHAN_THRESHOLD_MS
        );
        recoveredRuns.push(...orphaned);
      } catch (e) {
        this.deps.log.error("Recovery sweep failed to mark orphaned runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "orphaned",
          count: orphaned.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (timedOut.length > 0) {
      try {
        await store.bulkFailRunningRuns(
          timedOut.map((r) => r.id),
          EXECUTION_TIMEOUT_FAILURE_REASON,
          now,
          this.deps.executionDeadlineMs(DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS)
        );
        recoveredRuns.push(...timedOut);
      } catch (e) {
        this.deps.log.error("Recovery sweep failed to mark timed-out runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "timed_out",
          count: timedOut.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (recoveredRuns.length === 0) {
      await this.finalizationSweep();
      return;
    }

    // Failure accounting: strikes are per INVOCATION (CAS-deduped), so two
    // stuck children of one fan-out cost one strike, not two.
    const affectedInvocations = new Map<string, string>(); // invocation id → automation id
    for (const run of recoveredRuns) {
      affectedInvocations.set(run.invocation_id, run.automation_id);
    }

    for (const [invocationId, automationId] of affectedInvocations) {
      try {
        await this.deps.failures.applyInvocationOutcome(automationId, invocationId);
      } catch (e) {
        this.deps.log.error("Recovery sweep failed to track failures", {
          event: "scheduler.recovery.bulk_track_error",
          automation_id: automationId,
          invocation_id: invocationId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await this.finalizationSweep();
  }

  /**
   * D2c arm: invocation-level accounting missed in the crash window between a
   * child's terminal update and its callback's accounting — all-terminal
   * invocations with an uncounted failure, and failing automations whose
   * latest invocation may be a fully-completed one (missed reset). Every
   * application goes through the same CAS-guarded, idempotent helper, so
   * overlap with live callbacks is harmless.
   */
  private async finalizationSweep(): Promise<void> {
    const store = this.deps.store;
    const since = this.deps.clock.now() - INVOCATION_SWEEP_WINDOW_MS;
    try {
      await store.disableSettledOneShots();
      const uncounted = await store.getUncountedFailedInvocations(since, RECOVERY_SWEEP_LIMIT);
      for (const invocation of uncounted) {
        await this.deps.failures.applyInvocationOutcome(invocation.automation_id, invocation.id);
      }

      const resetCandidates = await store.getStaleFailureResetCandidates(
        since,
        RECOVERY_SWEEP_LIMIT
      );
      for (const candidate of resetCandidates) {
        await this.deps.failures.applyInvocationOutcome(
          candidate.automation_id,
          candidate.invocation_id
        );
      }
    } catch (e) {
      this.deps.log.error("Invocation finalization sweep failed", {
        event: "scheduler.recovery.finalization_error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
