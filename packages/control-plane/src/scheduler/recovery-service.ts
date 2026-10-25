import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import {
  EXECUTION_TIMEOUT_FAILURE_REASON,
  type AutomationStore,
  type AutomationRow,
  type AutomationRunRow,
  type TeamGrantsVersion,
} from "../db/automation-store";
import type { TeamStore } from "../db/teams";
import type { AutomationExecutionAuthorizationRequest } from "../automation/authorization-guard";
import type { GitHubEnrichment } from "../session/identity";
import type { Logger } from "../logger";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import {
  executionDenialReason,
  ownerExecutionPrincipal,
  type LaunchAdmissionOperations,
} from "./launch-admission";
import type { LaunchTargetSnapshot, RunLaunch } from "./launch-contracts";
import {
  AUTOMATION_LAUNCH_CONCURRENCY,
  MAX_RELAUNCHES_PER_TICK,
  DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS,
  forEachConcurrently,
} from "./launch-policy";
import type { AutomationRunLaunchService } from "./run-launch-service";
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

/** A retry admitted for relaunch, with the team grants version its claim must still match. */
interface AdmittedRetry {
  automation: AutomationRow;
  launch: RunLaunch;
  teamGrantsVersion?: TeamGrantsVersion;
}

export interface AutomationRecoveryServiceDeps {
  store: Pick<
    AutomationStore,
    | "bulkFailRunningRuns"
    | "bulkFailStartingRuns"
    | "claimRetry"
    | "failWithdrawnRetry"
    | "getById"
    | "getOrphanedStartingRuns"
    | "getRetriesToSettle"
    | "getRunsPastExecutionDeadline"
    | "getStaleFailureResetCandidates"
    | "getUncountedFailedInvocations"
    | "resolveCanonicalOwner"
  >;
  teams: Pick<TeamStore, "getById">;
  isAuthorized(request: AutomationExecutionAuthorizationRequest): Promise<boolean>;
  admission: LaunchAdmissionOperations;
  resolveScmEnrichment(userId: string): Promise<GitHubEnrichment | null>;
  launcher: Pick<AutomationRunLaunchService, "launch" | "recordFailure">;
  failures: Pick<AutomationFailureService, "applyInvocationOutcome">;
  executionDeadlineMs(settings: SandboxSettings): number;
  nowMs(): number;
  log: Logger;
}

/** Recover abandoned runs and missed accounting, and separately admit and claim due retries. */
export class AutomationRecoveryService {
  constructor(private readonly deps: AutomationRecoveryServiceDeps) {}

  /**
   * Relaunch scheduled runs whose launch failed before their prompt was sent, once their wait
   * is over, and fail waiting runs their automation no longer allows. Returns claimed attempts,
   * including attempts that fail admission or launch.
   */
  async retryDue(nowMs: number): Promise<number> {
    const store = this.deps.store;
    let pending: AutomationRunRow[];
    try {
      pending = await store.getRetriesToSettle(nowMs, MAX_RELAUNCHES_PER_TICK);
    } catch (e) {
      this.deps.log.error("Retry sweep failed to query waiting runs", {
        event: "scheduler.retry.query_error",
        error: e instanceof Error ? e.message : String(e),
      });
      return 0;
    }

    // Claim each run as its launch begins, so one queued behind slower launches is not
    // already aging toward the orphan sweep.
    let relaunched = 0;
    await forEachConcurrently(pending, AUTOMATION_LAUNCH_CONCURRENCY, async (run) => {
      try {
        if (await this.relaunch(run)) {
          relaunched++;
        } else if (await store.failWithdrawnRetry(run.id, this.deps.nowMs())) {
          // Paused, deleted, or its retry limit lowered while it waited: its last failure stands.
          await this.deps.failures.applyInvocationOutcome(run.automation_id, run.invocation_id);
        }
      } catch (e) {
        this.deps.log.error("Retry sweep failed to settle a waiting run", {
          event: "scheduler.retry.settle_error",
          automation_id: run.automation_id,
          run_id: run.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    return relaunched;
  }

  /**
   * Admit a due retry, claim it, and launch it. As for a first launch, admission comes first
   * and the claim is conditional on the team grants it checked. A denial or a failed admission
   * still claims the run, spending this attempt on it. Returns whether this tick claimed it.
   */
  private async relaunch(run: AutomationRunRow): Promise<boolean> {
    const store = this.deps.store;
    let admitted: AdmittedRetry | undefined;
    let admissionError: unknown;
    try {
      admitted = await this.admitRetry(run);
    } catch (e) {
      admissionError = e;
    }
    // Refused when another tick took it, its automation withdrew it, or its team's grants
    // changed after the check; in that last case the next tick admits it again.
    const claimed = await store.claimRetry(run, this.deps.nowMs(), admitted?.teamGrantsVersion);
    if (!claimed) return false;

    this.deps.log.info("Relaunching automation run", {
      event: "scheduler.retry_launch",
      automation_id: claimed.automation_id,
      invocation_id: claimed.invocation_id,
      run_id: claimed.id,
      attempt: claimed.attempt,
    });
    if (admitted) {
      await this.deps.launcher.launch(admitted.automation, claimed, admitted.launch);
    } else {
      await this.deps.launcher.recordFailure(claimed, admissionError, true);
    }
    if (claimed.status === "running" || claimed.status === "retrying") return true;
    try {
      await this.deps.failures.applyInvocationOutcome(claimed.automation_id, claimed.invocation_id);
    } catch (e) {
      this.deps.log.error("Failed to apply invocation accounting after a retry", {
        event: "scheduler.fail_track_error",
        automation_id: claimed.automation_id,
        invocation_id: claimed.invocation_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }

  /**
   * Admit a retry afresh for the run's own target: the owner must still be authorized to use
   * it, a team's grants must still cover it, and provider routing resolves again. A denial
   * throws, recording the run as unauthorized; the next scheduled firing then pauses the
   * automation if the denial persists.
   */
  private async admitRetry(run: AutomationRunRow): Promise<AdmittedRetry> {
    const store = this.deps.store;
    const stored = await store.getById(run.automation_id);
    if (!stored) throw new Error("Automation was deleted before its retry launched");
    const automation = await store.resolveCanonicalOwner(stored);
    const executionPrincipal = ownerExecutionPrincipal(automation);
    if (!executionPrincipal) throw new AutomationExecutionUnauthorizedError();
    const authorization: AutomationExecutionAuthorizationRequest = {
      automationId: automation.id,
      executionUserId: executionPrincipal.platformUserId,
      requiresRepositoryUse: run.repo_owner !== null,
      requiresEnvironmentUse: run.environment_id !== null,
    };
    const team =
      automation.owner_team_id === null
        ? null
        : await this.deps.teams.getById(automation.owner_team_id);
    if (!(await this.deps.isAuthorized(authorization))) {
      throw new AutomationExecutionUnauthorizedError(executionDenialReason(team));
    }
    let targets: ReadonlyMap<string, LaunchTargetSnapshot> = new Map();
    let teamGrantsVersion: TeamGrantsVersion | undefined;
    if (automation.owner_team_id !== null) {
      if (!team) throw new AutomationExecutionUnauthorizedError();
      const admittedTargets = await this.deps.admission.resolveTeamTargets(automation, team, [run]);
      if (!admittedTargets)
        throw new AutomationExecutionUnauthorizedError("target_team_missing_grant");
      ({ targets, teamGrantsVersion } = admittedTargets);
    }
    let launchError: unknown;
    try {
      executionPrincipal.scmEnrichment = await this.deps.resolveScmEnrichment(
        executionPrincipal.platformUserId
      );
    } catch (error) {
      launchError = error;
    }
    return {
      automation,
      teamGrantsVersion,
      launch: {
        executionPrincipal,
        authorization,
        providerAuthSnapshot: await this.deps.admission.resolveProviderAuth(automation),
        targets,
        launchError,
        retryable: true,
      },
    };
  }

  // ─── Recovery sweep ──────────────────────────────────────────────────────

  async recoverRuns(): Promise<void> {
    const store = this.deps.store;
    const now = this.deps.nowMs();
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
    const since = this.deps.nowMs() - INVOCATION_SWEEP_WINDOW_MS;
    try {
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
