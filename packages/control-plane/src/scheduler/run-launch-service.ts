import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import type { SessionContinuityService } from "./session-continuity-service";
import type * as Crypto from "../auth/crypto";
import type { AutomationRow, AutomationRunRow, AutomationStore } from "../db/automation-store";
import { HarnessAdmissionError } from "../harness-admission";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import type { Logger } from "../logger";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import type { AutomationSessionService } from "./automation-session-service";
import type { FirstPromptInput, RunLaunch } from "./launch-contracts";
import { DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS, launchRetryDelayMs } from "./launch-policy";

export interface AutomationRunLaunchServiceDeps {
  store: Pick<
    AutomationStore,
    "claimRunSession" | "failLaunchOrRetry" | "updateRun" | "markRunFirstPromptQueued"
  >;
  sessions: Pick<AutomationSessionService, "create">;
  enqueueFirstPrompt(input: FirstPromptInput): Promise<void>;
  continuity: Pick<SessionContinuityService, "releaseHeldPrompts">;
  executionDeadlineMs(settings: SandboxSettings): number;
  clock: Pick<DateConstructor, "now">;
  crypto: Pick<typeof Crypto, "generateId">;
  log: Logger;
}

/** Claim a run's session and queue its first prompt, containing and classifying launch failures. */
export class AutomationRunLaunchService {
  constructor(private readonly deps: AutomationRunLaunchServiceDeps) {}

  /**
   * Claim a session for the run, create it, and send the run's first prompt. Never throws: a
   * failure is recorded on the run (see {@link recordFailure}).
   */
  async launch(
    automation: AutomationRow,
    child: AutomationRunRow,
    launch: RunLaunch
  ): Promise<void> {
    let promptSent = false;
    try {
      if (launch.launchError !== undefined) throw launch.launchError;
      if ("error" in launch.providerAuthSnapshot) throw launch.providerAuthSnapshot.error;
      const targetSnapshot = launch.targets.get(child.id);
      if (targetSnapshot && "error" in targetSnapshot) throw targetSnapshot.error;
      const sessionId = this.deps.crypto.generateId();
      // Claim the generated session before initialization. Otherwise the orphan sweep can
      // terminalize an old `starting` row while initialization is still creating its session.
      // The deadline claimed here is the deployment-wide one; session creation replaces it
      // with the budget this session's own settings resolve to. If the worker dies in
      // between, the run stays covered by the shorter of the two, which is what a launch
      // that never finished deserves.
      const claimedAt = this.deps.clock.now();
      const claimed = await this.deps.store.claimRunSession(
        child.id,
        sessionId,
        claimedAt,
        claimedAt + this.deps.executionDeadlineMs(DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS)
      );
      if (!claimed) {
        throw new Error("Automation run was recovered before launch claimed its session");
      }
      await this.deps.sessions.create({
        automation,
        run: child,
        providerAuth: launch.providerAuthSnapshot.providerAuth,
        sessionId,
        executionPrincipal: launch.executionPrincipal,
        startedAtMs: claimedAt,
        admission: {
          authorization: launch.authorization,
          target: targetSnapshot && "target" in targetSnapshot ? targetSnapshot.target : undefined,
        },
      });
      // From here the session may take the prompt even when the call fails, and a second
      // session would run it twice, so a failure is no longer retried.
      promptSent = true;
      await this.deps.enqueueFirstPrompt({
        sessionId,
        automation,
        runId: child.id,
        executionPrincipal: launch.executionPrincipal,
        instructionsOverride: launch.instructionsOverride,
      });
      child.status = "running";
      child.session_id = sessionId;
      await this.releaseFollowUpsHeldDuringLaunch(child);
    } catch (e) {
      await this.recordFailure(child, e, launch.retryable && !promptSent);
    }
  }

  /**
   * Record why a run's launch failed, on the row and on `child`. A `retryable` failure waits to
   * relaunch while its automation allows another attempt.
   */
  async recordFailure(child: AutomationRunRow, error: unknown, retryable: boolean): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log.error("Failed to launch automation run", {
      event: "scheduler.session_creation_failed",
      automation_id: child.automation_id,
      invocation_id: child.invocation_id,
      run_id: child.id,
      attempt: child.attempt ?? 1,
      error: message,
    });
    // Losing authorization is not an automation failure: the run is unauthorized, so only
    // genuine sibling failures count a strike. The next admission re-evaluates the
    // principal and pauses if still denied.
    let outcome: Partial<AutomationRunRow> =
      error instanceof AutomationExecutionUnauthorizedError
        ? { status: "unauthorized", failure_reason: error.reason, session_id: null }
        : { status: "failed", failure_reason: message };
    try {
      const failedAt = this.deps.clock.now();
      // A harness or provider-account configuration that cannot run fails every attempt alike,
      // so it is not retried.
      const configurationError =
        error instanceof HarnessAdmissionError ||
        error instanceof ProviderAccountSelectionPolicyError;
      if (outcome.status === "failed" && retryable && !configurationError) {
        const retryAt = failedAt + launchRetryDelayMs(child.attempt ?? 1);
        if (
          (await this.deps.store.failLaunchOrRetry(child.id, message, failedAt, retryAt)) ===
          "retrying"
        ) {
          outcome = { ...outcome, status: "retrying", retry_at: retryAt, session_id: null };
          this.deps.log.info("Automation run will retry its launch", {
            event: "scheduler.launch_retry_scheduled",
            automation_id: child.automation_id,
            invocation_id: child.invocation_id,
            run_id: child.id,
            attempt: child.attempt ?? 1,
            retry_at: retryAt,
          });
        }
      } else {
        await this.deps.store.updateRun(child.id, { ...outcome, completed_at: failedAt });
      }
    } catch (updateError) {
      this.deps.log.error("Failed to record launch failure", {
        event: "scheduler.fail_track_error",
        automation_id: child.automation_id,
        run_id: child.id,
        original_reason: message,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    }
    Object.assign(child, outcome);
  }

  /**
   * Follow-ups that continued this run's session while it launched were held so they
   * land after its first prompt, which is now queued. Never throws: the launch itself
   * succeeded, and the held-prompt sweep retries a failed release.
   */
  private async releaseFollowUpsHeldDuringLaunch(run: AutomationRunRow): Promise<void> {
    try {
      await this.deps.store.markRunFirstPromptQueued(run.id);
      await this.deps.continuity.releaseHeldPrompts(run);
    } catch (error) {
      this.deps.log.error("Failed to release follow-ups held during launch", {
        event: "scheduler.held_prompt_release_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
