import type * as Crypto from "../auth/crypto";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  type AutomationInvocationSource,
} from "@open-inspect/shared/types/automations";
import {
  isDuplicateKeyError,
  allRunsUnauthorized,
  type AutomationStore,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationInvocationRow,
  type InvocationActorKind,
  type InvocationOverlapScope,
  type ScheduleAdvance,
  type AutomationRepositoryInsert,
  type AutomationEnvironmentRow,
  type TeamGrantsVersion,
} from "../db/automation-store";
import type { TeamStore } from "../db/teams";
import type { AutomationExecutionAuthorizationRequest } from "../automation/authorization-guard";
import type { resolveAutomationRepositories } from "../automation/repository";
import type { Logger } from "../logger";
import type { AutomationAttributionService } from "./attribution-service";
import { executionDenialReason, ownerExecutionPrincipal } from "./launch-admission";
import type {
  ExecutionPrincipal,
  LaunchTargetSnapshot,
  ProviderAuthSnapshot,
  RunLaunch,
} from "./launch-contracts";
import type { LaunchAdmissionOperations } from "./launch-admission-service";
import {
  AUTOMATION_LAUNCH_CONCURRENCY,
  MAX_RELAUNCHES_PER_TICK,
  forEachConcurrently,
} from "./launch-policy";
import type { AutomationRunLaunchService } from "./run-launch-service";
import type { AutomationFailureService } from "./failure-service";
import { AutomationExecutionUnauthorizedError } from "./contracts";
import type { StartInvocationResult } from "./invocation-outcome";

/**
 * The automation's concurrency bound. Anything that is not a positive integer
 * reads as DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS rather than as an unbounded
 * one: the predicate compares a count against this, and a comparison against
 * NaN is false — which would admit every firing instead of refusing them. The
 * column is NOT NULL with a SQL default, so this only guards rows assembled
 * outside SQL.
 */
function automationConcurrencyLimit(automation: AutomationRow): number {
  const limit = automation.max_concurrent_runs;
  return Number.isInteger(limit) && limit >= 1 ? limit : DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS;
}
export interface StartInvocationParams {
  automation: AutomationRow;
  source: AutomationInvocationSource;
  /**
   * Who authored the triggering action. Required, so a new firing path has to
   * decide: limits on bot-started runs count only `bot`.
   */
  actorKind: InvocationActorKind;
  invocationId?: string;
  /** Human authority used for a manual firing; unattended sources use the automation owner. */
  executionPrincipal?: ExecutionPrincipal;
  /** Cron slot being served — becomes scheduled_at and the idempotency key (schedule source only). */
  scheduledAt?: number;
  /** Next slot, or null to consume a one-shot; advanced atomically with its invocation. */
  advanceToNextRunAt?: number | null;
  triggerKey?: string | null;
  /** Finalize a webhook follow-up reservation as soon as its invocation is admitted. */
  webhookFollowUpClaimId?: string;
  concurrencyKey?: string | null;
  /** Source-specific JSON stored on the invocation (slack message coordinates). */
  triggerMetadata?: string | null;
  /** Pre-fetched repository selection (the tick passes its batched fetch). */
  repositories?: AutomationRepositoryInsert[];
  /** GitHub event identity that repository resolution must preserve. */
  eventRepositoryId?: number;
  /** Pre-fetched environment selection (the tick passes its batched fetch). */
  environments?: AutomationEnvironmentRow[];
  /** Complete prompt to use directly, or as the fallback for a lazy override. */
  instructionsOverride?: string;
  /**
   * Lazy alternative to `instructionsOverride`, resolved only after the
   * invocation is admitted. Slack runs use it so thread history is fetched for
   * runs that actually start — never for unmatched events, steers, concurrency
   * skips or deduplicated firings. If resolution fails, start uses
   * `instructionsOverride` so admitted children cannot be stranded.
   */
  instructionsOverrideFactory?: () => Promise<string>;
}

/** A retry admitted for relaunch, with the team grants version its claim must still match. */
interface AdmittedRetry {
  automation: AutomationRow;
  launch: RunLaunch;
  teamGrantsVersion?: TeamGrantsVersion;
}

export interface AutomationInvocationServiceDeps {
  store: Pick<
    AutomationStore,
    | "acceptFollowUpReceipt"
    | "advanceNextRunAt"
    | "claimRetry"
    | "countActiveInvocations"
    | "failWithdrawnRetry"
    | "getById"
    | "getRetriesToSettle"
    | "getActiveRunForKey"
    | "getEnvironmentsForAutomation"
    | "getInvocationIdByTriggerKey"
    | "getRepositoriesForAutomation"
    | "insertInvocationGuarded"
    | "insertSkippedInvocation"
    | "resolveCanonicalOwner"
  >;
  teams: Pick<TeamStore, "getById">;
  isAuthorized(request: AutomationExecutionAuthorizationRequest): Promise<boolean>;
  resolveRepositories(
    repositories: AutomationRepositoryInsert[]
  ): ReturnType<typeof resolveAutomationRepositories>;
  admission: LaunchAdmissionOperations;
  attribution: Pick<AutomationAttributionService, "resolve">;
  launcher: Pick<AutomationRunLaunchService, "launch" | "recordFailure">;
  failures: Pick<AutomationFailureService, "applyInvocationOutcome">;
  clock: Pick<DateConstructor, "now">;
  crypto: Pick<typeof Crypto, "generateId">;
  log: Logger;
}

/** Admit new firings and due retries, preserving their distinct launch preparation order. */
export class AutomationInvocationService {
  constructor(private readonly deps: AutomationInvocationServiceDeps) {}

  /**
   * The single firing pipeline (D6): overlap check per source, atomic
   * invocation+children insert with self-guarded statements, repository
   * resolution with per-repo error capture, child launches, and born-terminal
   * finalization. Tick, manual trigger, and the event path all come through
   * here.
   */
  async start(params: StartInvocationParams): Promise<StartInvocationResult> {
    const store = this.deps.store;
    const { source } = params;
    const automation = await store.resolveCanonicalOwner(params.automation);
    const executionPrincipal = params.executionPrincipal ?? ownerExecutionPrincipal(automation);
    if (!executionPrincipal) return { outcome: "unauthorized" };
    const now = this.deps.clock.now();
    const concurrencyKey = params.concurrencyKey ?? null;
    const triggerKey = params.triggerKey ?? null;

    // A redelivered event (or a webhook retry with the same idempotency key)
    // belongs to the firing that already admitted it — even while that firing
    // is still running, which the overlap check below would otherwise record
    // as a fresh skip.
    if (triggerKey !== null) {
      const ownerId = await store.getInvocationIdByTriggerKey(automation.id, triggerKey);
      if (ownerId) return { outcome: "deduplicated", invocationId: ownerId };
    }

    // Schedule/manual firings block once the automation is at its concurrency
    // limit; event firings block per concurrency key (an automation-wide guard
    // would serialize unrelated events, e.g. PR #42 against PR #43).
    //
    // The limit is read off the automation row rather than passed in, so an
    // operator raising it takes effect on the next firing and an automation
    // that predates the column keeps the serialized behaviour its default
    // encodes.
    const overlapScope: InvocationOverlapScope =
      source === "event" && concurrencyKey !== null
        ? { kind: "concurrencyKey", concurrencyKey }
        : { kind: "automation" };

    // Cheap pre-check; the conditional insert below re-applies the same
    // predicate atomically, so a race here only costs a wasted child build.
    // This half compares against the snapshot the firing was read with, while
    // the insert re-reads the bound from the row — deliberately, since the
    // authoritative answer is the one the database orders against a PATCH.
    const blocked =
      overlapScope.kind === "concurrencyKey"
        ? (await store.getActiveRunForKey(automation.id, concurrencyKey)) !== null
        : (await store.countActiveInvocations(automation.id)) >=
          automationConcurrencyLimit(automation);
    if (blocked) {
      return this.recordOverlapSkip(params, { advanceSchedule: true });
    }

    const [selection, environmentSelection] = await Promise.all([
      params.repositories ?? store.getRepositoriesForAutomation(automation.id),
      params.environments ?? store.getEnvironmentsForAutomation(automation.id),
    ]);
    // One snapshot of the owning team classifies denials and pins the grants version.
    const team =
      automation.owner_team_id === null
        ? null
        : await this.deps.teams.getById(automation.owner_team_id);
    const authorization: AutomationExecutionAuthorizationRequest = {
      automationId: automation.id,
      executionUserId: executionPrincipal.platformUserId,
      requiresRepositoryUse: selection.length > 0,
      requiresEnvironmentUse: environmentSelection.length > 0,
    };
    if (!(await this.deps.isAuthorized(authorization))) {
      return { outcome: "unauthorized", reason: executionDenialReason(team) };
    }
    const resolutions = await this.deps.resolveRepositories(selection);
    for (const resolution of resolutions) {
      if (
        params.eventRepositoryId !== undefined &&
        resolution.repository !== null &&
        resolution.repository.repoId !== params.eventRepositoryId
      ) {
        resolution.repository = null;
        resolution.error = "Repository identity changed during event resolution";
      }
    }

    const invocationId = params.invocationId ?? this.deps.crypto.generateId();
    const scheduledAt = params.scheduledAt ?? now;

    const childBase = () => ({
      id: this.deps.crypto.generateId(),
      automation_id: automation.id,
      invocation_id: invocationId,
      session_id: null,
      skip_reason: null,
      failure_reason: null,
      scheduled_at: scheduledAt,
      started_at: null,
      // Stamped by the claim, once the run has a session whose budget to spend.
      // Until then the orphan sweep owns it.
      execution_deadline_at: null,
      completed_at: null,
      created_at: now,
      // Raised by the claim, until the run's first prompt is queued.
      first_prompt_pending: 0,
      repo_owner: null,
      repo_name: null,
      repo_id: null,
      base_branch: null,
      environment_id: null,
    });

    // One child per target. Repository children snapshot the resolved repo; a
    // failed resolution pre-fails its child (snapshot from the selection row)
    // without blocking siblings. Environment children snapshot their id; team
    // workspaces are resolved before grant admission below. Resolution errors
    // remain launch failures. No targets produce one repo-less child.
    const children: AutomationRunRow[] = [
      ...resolutions.map((resolution): AutomationRunRow => ({
        ...childBase(),
        status: resolution.error ? "failed" : "starting",
        failure_reason: resolution.error,
        completed_at: resolution.error ? now : null,
        repo_owner: resolution.repository?.repoOwner ?? resolution.requested.repo_owner,
        repo_name: resolution.repository?.repoName ?? resolution.requested.repo_name,
        repo_id: resolution.repository?.repoId ?? resolution.requested.repo_id,
        base_branch: resolution.repository?.baseBranch ?? resolution.requested.base_branch,
      })),
      ...environmentSelection.map((environment): AutomationRunRow => ({
        ...childBase(),
        status: "starting",
        environment_id: environment.environment_id,
      })),
    ];
    if (children.length === 0) {
      children.push({ ...childBase(), status: "starting" });
    }

    const launchCandidates = children.filter((child) => child.status === "starting");
    let launchTargets: ReadonlyMap<string, LaunchTargetSnapshot> = new Map();
    let teamGrantsVersion: TeamGrantsVersion | undefined;
    if (automation.owner_team_id !== null) {
      if (!team) return { outcome: "unauthorized", reason: "execution_authorization_denied" };
      // The guarded insert refuses admission if grants change after coverage is checked.
      const admitted = await this.deps.admission.resolveTeamTargets(
        automation,
        team,
        launchCandidates
      );
      if (!admitted) return { outcome: "unauthorized", reason: "target_team_missing_grant" };
      ({ targets: launchTargets, teamGrantsVersion } = admitted);
    }
    // Resolve provider routing before admission, alongside the already-built
    // target children. Together these values are the immutable launch snapshot
    // for this firing: edits made after the conditional insert cannot change which
    // account an admitted child uses.
    const providerAuthSnapshot: ProviderAuthSnapshot =
      launchCandidates.length > 0
        ? await this.deps.admission.resolveProviderAuth(automation)
        : { providerAuth: [] };

    const invocation: AutomationInvocationRow = {
      id: invocationId,
      automation_id: automation.id,
      source,
      actor_kind: params.actorKind,
      scheduled_at: params.scheduledAt ?? null,
      trigger_key: triggerKey,
      concurrency_key: concurrencyKey,
      trigger_metadata: params.triggerMetadata ?? null,
      skip_reason: null,
      failure_counted_at: null,
      created_at: now,
      updated_at: now,
    };

    let inserted: boolean;
    try {
      ({ inserted } = await store.insertInvocationGuarded({
        invocation,
        children,
        overlapScope,
        teamGrantsVersion,
        advanceSchedule:
          source === "schedule" &&
          params.scheduledAt !== undefined &&
          params.advanceToNextRunAt !== undefined
            ? { fromSlot: params.scheduledAt, nextRunAt: params.advanceToNextRunAt }
            : undefined,
      }));
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        // A UNIQUE violation rolls back the whole batch INCLUDING the schedule
        // advance. The colliding firing owns this slot (cron double-fire) or
        // event (trigger_key dedup) — re-advance and stand down.
        if (source === "schedule" && params.advanceToNextRunAt != null) {
          // Monotonic: never rewind the schedule. A stale duplicate for an old
          // slot must not move next_run_at behind a newer tick's advance.
          await store.advanceNextRunAt(automation.id, params.advanceToNextRunAt);
        }
        return {
          outcome: "deduplicated",
          invocationId:
            triggerKey === null
              ? null
              : await store.getInvocationIdByTriggerKey(automation.id, triggerKey),
        };
      }
      throw e;
    }

    if (!inserted && teamGrantsVersion) {
      const current = await this.deps.teams.getById(teamGrantsVersion.teamId);
      if (current?.grantsVersion !== teamGrantsVersion.version) {
        // Grants changed after coverage was checked. Nothing was recorded or
        // advanced, so a schedule slot refires and re-authorizes on the next tick.
        return { outcome: "blocked", reason: "team_grants_changed" };
      }
    }
    if (!inserted) {
      // Raced an active invocation between the pre-check and the batch. The
      // recurring schedule already advanced. A one-shot keeps its slot until
      // the skip is recorded, so disabling it cannot lose the history entry.
      return this.recordOverlapSkip(params, {
        advanceSchedule: automation.schedule_once_at != null,
      });
    }

    if (params.webhookFollowUpClaimId && triggerKey) {
      try {
        await store.acceptFollowUpReceipt(
          automation.id,
          triggerKey,
          params.webhookFollowUpClaimId,
          invocationId,
          this.deps.clock.now()
        );
      } catch (error) {
        // The invocation's unique trigger key is already the durable owner; receipt repair
        // must not strand its admitted children before launch.
        this.deps.log.warn("Failed to finalize an admitted webhook follow-up receipt", {
          event: "scheduler.webhook_receipt_finalize_failed",
          automation_id: automation.id,
          invocation_id: invocationId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    let attributionError: unknown;
    if (!params.executionPrincipal && launchCandidates.length > 0) {
      try {
        executionPrincipal.scmEnrichment = await this.deps.attribution.resolve(
          executionPrincipal.platformUserId
        );
      } catch (error) {
        attributionError = error;
      }
    }

    // Admitted. Only now is it worth paying for anything the prompt needs.
    // Contain provider failures here: children already exist in `starting`, so
    // a rejected lazy override must not escape and strand persisted state.
    let instructionsOverride = params.instructionsOverride;
    if (params.instructionsOverrideFactory) {
      try {
        instructionsOverride = await params.instructionsOverrideFactory();
      } catch (error) {
        this.deps.log.warn("Failed to resolve lazy instructions; using fallback", {
          event: "scheduler.instructions_override_failed",
          automation_id: automation.id,
          invocation_id: invocationId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    const launch: RunLaunch = {
      executionPrincipal,
      authorization,
      providerAuthSnapshot,
      targets: launchTargets,
      instructionsOverride,
      launchError: attributionError,
      retryable: source === "schedule" && (automation.max_retries ?? 0) > 0,
    };
    await forEachConcurrently(launchCandidates, AUTOMATION_LAUNCH_CONCURRENCY, (child) =>
      this.deps.launcher.launch(automation, child, launch)
    );
    const launched = launchCandidates.filter((child) => child.status === "running").length;

    // Pre-failed and launch-failed children have no callback coming — apply
    // the failure strike now (CAS-deduped). This is also the born-terminal
    // path: every repo inaccessible → invocation finalizes immediately.
    if (children.some((child) => child.status === "failed") || allRunsUnauthorized(children)) {
      try {
        await this.deps.failures.applyInvocationOutcome(automation.id, invocationId);
      } catch (e) {
        this.deps.log.error("Failed to apply invocation accounting after launch failures", {
          event: "scheduler.fail_track_error",
          automation_id: automation.id,
          invocation_id: invocationId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { outcome: "started", invocationId, runs: children, launched };
  }

  /**
   * Record an event firing refused before admission (such as the Slack bot
   * message limit) under `skipReason`, as the same childless skipped invocation
   * an overlap skip leaves.
   */
  async skipEvent(
    params: Pick<
      StartInvocationParams,
      "automation" | "actorKind" | "triggerKey" | "concurrencyKey" | "triggerMetadata"
    >,
    skipReason: string
  ): Promise<StartInvocationResult> {
    return this.recordSkip({ ...params, source: "event" }, skipReason);
  }

  /**
   * Record an overlap-blocked firing. Manual firings surface as a 409 with no
   * row; schedule and event firings persist a childless skipped invocation —
   * for schedule slots atomically with the schedule advance (a skip recorded
   * without its advance would re-collide on the same slot every tick).
   */
  private async recordOverlapSkip(
    params: StartInvocationParams,
    options: { advanceSchedule: boolean }
  ): Promise<StartInvocationResult> {
    if (params.source === "manual") return { outcome: "blocked", reason: "concurrent_run_active" };
    return this.recordSkip(
      params,
      "concurrent_run_active",
      options.advanceSchedule &&
        params.source === "schedule" &&
        params.scheduledAt !== undefined &&
        params.advanceToNextRunAt !== undefined
        ? { fromSlot: params.scheduledAt, nextRunAt: params.advanceToNextRunAt }
        : undefined
    );
  }

  /**
   * Persist a childless skipped invocation. A skip never stores the event
   * trigger_key: a skip must not consume the dedup slot of a firing that never
   * ran.
   */
  private async recordSkip(
    params: StartInvocationParams,
    skipReason: string,
    scheduleAdvance?: ScheduleAdvance
  ): Promise<StartInvocationResult> {
    const store = this.deps.store;
    // The firing that already admitted this event owns it: a concurrent same-key
    // delivery may have committed with its active child since the overlap
    // pre-check, and a redelivered message may have been admitted before a
    // pre-admission limit was reached.
    if (params.triggerKey) {
      const ownerId = await store.getInvocationIdByTriggerKey(
        params.automation.id,
        params.triggerKey
      );
      if (ownerId) return { outcome: "deduplicated", invocationId: ownerId };
    }

    const now = this.deps.clock.now();
    const invocationId = this.deps.crypto.generateId();
    const { inserted } = await store.insertSkippedInvocation(
      {
        id: invocationId,
        automation_id: params.automation.id,
        source: params.source,
        actor_kind: params.actorKind,
        scheduled_at: params.scheduledAt ?? null,
        trigger_key: null,
        concurrency_key: params.concurrencyKey ?? null,
        trigger_metadata: params.triggerMetadata ?? null,
        skip_reason: skipReason,
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      },
      scheduleAdvance
    );
    return { outcome: "skipped", invocationId: inserted ? invocationId : null };
  }

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
        } else if (await store.failWithdrawnRetry(run.id, this.deps.clock.now())) {
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
    const claimed = await store.claimRetry(run, this.deps.clock.now(), admitted?.teamGrantsVersion);
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
      executionPrincipal.scmEnrichment = await this.deps.attribution.resolve(
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
}
