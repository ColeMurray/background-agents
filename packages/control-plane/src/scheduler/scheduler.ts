/**
 * Request-driven automation scheduler backed entirely by D1.
 *
 * Invoked by the Worker's `scheduled()` handler, automation routes, and
 * SessionDO completion callbacks. Handles:
 * - Tick: recovery sweep + process overdue automations
 * - Trigger: manual single-automation trigger
 * - RunComplete: callback from SessionDO on execution completion
 */

import {
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  buildSlackContextBlock,
  slackChannelLabel,
  type AutomationEvent,
  type SlackAutomationEvent,
} from "@open-inspect/shared/triggers";
import { nextCronOccurrence } from "@open-inspect/shared/cron";
import type {
  AutomationInvocationSource,
  AutomationRun,
} from "@open-inspect/shared/types/automations";
import type { AutomationCallbackContext } from "@open-inspect/shared/types/session-api";
import type { Team } from "@open-inspect/shared/types/teams";
import { computeHmacHex } from "@open-inspect/shared/auth";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { z } from "zod";
import { callbackSigningSecret } from "../auth/service/callback-signing";
import {
  AutomationStore,
  allRunsUnauthorized,
  EXECUTION_TIMEOUT_FAILURE_REASON,
  toAutomationRun,
  isDuplicateKeyError,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationInvocationRow,
  type InvocationOverlapScope,
  type AutomationRepositoryInsert,
  type AutomationEnvironmentRow,
} from "../db/automation-store";
import {
  AutomationModelProviderAuthStore,
  toProviderSelections,
} from "../db/automation-model-provider-auth";
import { buildSlackSkipNotification } from "./slack-completion";
import { getUserAuth } from "../auth/user/runtime";
import { GitHubAttributionUnavailableError } from "../source-control/github-credential-authority";
import { UserStore } from "../db/user-store";
import { TeamStore } from "../db/teams";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { generateId } from "../auth/crypto";
import { createLogger, parseLogLevel } from "../logger";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { validateHarnessExecution } from "../harness-admission";
import type { SqlDatabase } from "../db/sql-database";
import type { BackgroundTasks } from "../platform-ports";
import { initializeSession } from "../session/initialize";
import type { SessionInitInput } from "../session/initialize";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolveExecutionBudgetMs } from "../sandbox/execution-budget";
import { MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS } from "../image-builds/timeouts";
import { resolveManagedSkills } from "../session/skill-resolution";
import { dispatchAutomationEvent } from "./event-dispatch";
import { notifySlackCompletion } from "./slack-event-policy";
import { resolvedPin } from "../session/pinned";
import { createSessionMemorySelector } from "../memory/session-memory-selector-factory";
import { resolveAutomationRepositories } from "../automation/repository";
import {
  resolveAutomationSessionTarget,
  type AutomationSessionTarget,
} from "../automation/session-target";
import {
  isAutomationExecutionAuthorized,
  type AutomationExecutionAuthorizationRequest,
} from "../automation/authorization-guard";
import type { AutomationTriggerBlockedReason, StartInvocationResult } from "./invocation-outcome";
import type { RequestContext } from "../routes/shared";
import {
  firstPromptRequestId,
  releaseHeldPrompts,
  sweepHeldPrompts,
  type SessionContinuityDeps,
} from "./session-continuity";
import { enqueueSessionPrompt } from "./session-prompt";
import {
  AmbiguousGitHubIdentityError,
  resolveGitHubEnrichmentForCanonicalUser,
  type GitHubEnrichment,
} from "../session/identity";
import { resolveScmProviderFromEnv } from "../source-control/config";

export { composeAutomationPrompt } from "./event-prompt";
export { SessionFollowUpRefusedError } from "./session-continuity";

/** Max automations to process per tick (backpressure). */
const MAX_PER_TICK = 25;

/**
 * Per-tick cap on child-run launches. Each launch costs ~8 subrequests, so an
 * uncapped 25-automation × 10-repo tick would blow the Workers per-invocation
 * subrequest limit; automations left overdue when the budget runs out are
 * simply picked up next tick.
 */
const TICK_CHILD_LAUNCH_BUDGET = 50;

/**
 * Smooths Modal cold-start pressure for multi-repo fan-out. The maximum fan-out
 * is 10 repositories, so this only caps the per-invocation spike.
 */
const AUTOMATION_LAUNCH_CONCURRENCY = 4;

/** Threshold for detecting orphaned "starting" runs (5 minutes). */
const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Launch work the deadline must still cover once the longest image build has
 * finished: sandbox spawn, prompt enqueue, and the slack in the session
 * watchdog's own alarm scheduling.
 */
const EXECUTION_DEADLINE_LAUNCH_ALLOWANCE_MS = 30 * 60 * 1000;

/**
 * Head start the session's own execution watchdog gets over the recovery
 * sweep. A run's clock starts at claim; the watchdog's starts when the message
 * begins processing, after any repository image build and the sandbox spawn.
 * The grace is derived from the build provider-session bound rather than
 * chosen, so a build that spends its entire budget still cannot let the sweep
 * fire before the session fails its own message and the callback carries the
 * real reason. The sweep exists to catch a lost callback, and reaping a live
 * run is far worse than reaping a dead one late.
 */
export const EXECUTION_DEADLINE_GRACE_MS =
  MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS + EXECUTION_DEADLINE_LAUNCH_ALLOWANCE_MS;

/**
 * Settings a session is created with when neither its repository nor its
 * environment overrides the sandbox defaults; the budget then comes from the
 * deployment configuration alone.
 */
const DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {};

/** Consecutive failure threshold for auto-pause. */
const AUTO_PAUSE_THRESHOLD = 3;

/** Max runs to recover per sweep type per tick (backpressure). */
const RECOVERY_SWEEP_LIMIT = 50;

/**
 * How far back the finalization sweep scans invocations for missed failure
 * strikes or resets (the crash-after-last-callback window is seconds; a day
 * keeps the derived-status scan cheap while covering long outages).
 */
const INVOCATION_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Bound on the thread-context request. It sits between admission and launch, so
 * a slow Slack read would hold every child in `starting` until the orphan sweep
 * repairs them. Matches the callback-delivery attempt timeout; on expiry the run
 * launches with no thread history, which is the same fallback as any other
 * failure.
 */
const SLACK_THREAD_CONTEXT_TIMEOUT_MS = 10_000;

const slackThreadContextResponseSchema = z.object({
  threadContext: z.string(),
});

export interface AutomationRunCompletion {
  automationId: string;
  runId: string;
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
}

export interface SchedulerTickResult {
  processed: number;
  skipped: number;
  failed: number;
}

export type { AutomationTriggerBlockedReason, StartInvocationResult } from "./invocation-outcome";

export interface SchedulerEventResult {
  triggered: number;
  skipped: number;
  steered: number;
  /** Invocations representing this event's firings (see firingInvocationId). */
  invocationIds: string[];
}

export interface SchedulerTriggerResult {
  invocationId: string;
  runs: AutomationRun[];
}

export class AutomationTriggerBlockedError extends Error {
  constructor(readonly reason: AutomationTriggerBlockedReason = "concurrent_run_active") {
    super(
      reason === "team_grants_changed"
        ? "Team repository grants changed during admission"
        : "An active run already exists"
    );
    this.name = "AutomationTriggerBlockedError";
  }
}

/** Raised when an automation's execution principal lacks required authorization. */
export class AutomationExecutionUnauthorizedError extends Error {
  /** Create an error for an unauthorized automation execution principal. */
  constructor(readonly reason = "execution_authorization_denied") {
    super("Automation execution principal is not authorized");
    this.name = "AutomationExecutionUnauthorizedError";
  }
}

export interface StartInvocationParams {
  automation: AutomationRow;
  source: AutomationInvocationSource;
  invocationId?: string;
  /** Human authority used for a manual firing; unattended sources use the automation owner. */
  executionPrincipal?: ExecutionPrincipal;
  /** Cron slot being served — becomes scheduled_at and the idempotency key (schedule source only). */
  scheduledAt?: number;
  /** Next cron slot, advanced atomically with the insert (schedule source only). */
  advanceToNextRunAt?: number;
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
   * skips or deduplicated firings. If resolution fails, startInvocation uses
   * `instructionsOverride` so admitted children cannot be stranded.
   */
  instructionsOverrideFactory?: () => Promise<string>;
}

interface ExecutionPrincipal {
  platformUserId: string;
  participantUserId: string;
  scmEnrichment: GitHubEnrichment | null;
}

export async function resolveAutomationProviderAuth(
  db: SqlDatabase,
  automationId: string,
  harness: HarnessId = DEFAULT_HARNESS
): Promise<SessionModelProviderAuthInput[]> {
  const pinRows = await new AutomationModelProviderAuthStore(db).list(automationId);
  const explicit = toProviderSelections(pinRows);
  const resolved = await resolveSessionProviderAuth(db, { explicit, unattended: true, harness });
  const pinnedProviders = new Set(pinRows.map((pin) => pin.provider));
  return resolved.map((auth) =>
    pinnedProviders.has(auth.provider) && auth.selectionSource === "explicit"
      ? { ...auth, selectionSource: "automation_pin" }
      : auth
  );
}

/** Reason code for an execution authorization denial, given the owning team's current state. */
function executionDenialReason(team: Team | null): string {
  return team?.archivedAt != null ? "team_archived" : "execution_authorization_denied";
}

/** What admission decided for a firing, re-checked as each child launches. */
interface LaunchAdmission {
  authorization: AutomationExecutionAuthorizationRequest;
  /** Session target resolved at admission; required for team automations. */
  target?: AutomationSessionTarget;
}

/** Coordinates authorized automation scheduling, dispatch, and completion handling. */
/** A launch candidate's target as resolved at admission, or why it could not be resolved. */
type LaunchTargetSnapshot = { target: AutomationSessionTarget } | { error: unknown };

/** Repository IDs that the resolved launch targets will open. */
function launchTargetRepoIds(snapshots: ReadonlyMap<string, LaunchTargetSnapshot>): number[] {
  return [...snapshots.values()].flatMap((snapshot) => {
    if (!("target" in snapshot)) return [];
    const { target } = snapshot;
    if (target.repositories) return target.repositories.map((repository) => repository.repoId);
    return target.repoId === null ? [] : [target.repoId];
  });
}

export class Scheduler {
  private readonly log: Logger;

  constructor(
    private readonly db: SqlDatabase,
    private readonly env: Env,
    private readonly backgroundJobs: BackgroundTasks
  ) {
    this.log = createLogger("scheduler", {}, parseLogLevel(env.LOG_LEVEL));
  }

  /**
   * Increment the automation's failure streak and auto-pause at the threshold.
   * Callers gate this per-invocation via the failure_counted_at CAS.
   */
  private async trackAutomationFailure(
    store: AutomationStore,
    automationId: string
  ): Promise<void> {
    const count = await store.incrementConsecutiveFailures(automationId);
    if (count >= AUTO_PAUSE_THRESHOLD) {
      await store.autoPause(automationId);
      this.log.warn("Automation auto-paused due to consecutive failures", {
        event: "scheduler.auto_pause",
        automation_id: automationId,
        consecutive_failures: count,
      });
    }
  }

  /**
   * Invocation-level failure/success accounting (D2). Aggregates the sibling
   * runs and applies at most one consecutive-failures strike per invocation
   * (the failure_counted_at CAS admits a single winner across concurrent
   * callbacks, launch failures, and sweeps) or — once every child completed —
   * the streak reset. Idempotent by construction: safe to call after every
   * child transition and again from the finalization sweep.
   */
  private async applyInvocationAccounting(
    store: AutomationStore,
    automationId: string,
    invocationId: string
  ): Promise<void> {
    const aggregate = await store.getInvocationRunAggregate(invocationId);
    if (aggregate.total === 0) return; // childless skip — never counts

    if (aggregate.failed > 0) {
      const won = await store.tryMarkInvocationFailureCounted(invocationId);
      if (!won) return;
      await this.trackAutomationFailure(store, automationId);
    } else if (aggregate.active === 0 && aggregate.completed === aggregate.total) {
      await store.resetConsecutiveFailures(automationId);
    }
  }

  // ─── Invocation creation (all three entry points) ────────────────────────

  /**
   * The single firing pipeline (D6): overlap check per source, atomic
   * invocation+children insert with self-guarded statements, repository
   * resolution with per-repo error capture, child launches, and born-terminal
   * finalization. Tick, manual trigger, and the event path all come through
   * here.
   */
  private async startInvocation(
    store: AutomationStore,
    params: StartInvocationParams
  ): Promise<StartInvocationResult> {
    const { source } = params;
    const automation = await store.resolveCanonicalOwner(params.automation);
    const executionPrincipal =
      params.executionPrincipal ??
      (automation.user_id
        ? {
            platformUserId: automation.user_id,
            participantUserId: automation.created_by,
            scmEnrichment: null,
          }
        : null);
    if (!executionPrincipal) return { outcome: "unauthorized" };
    const now = Date.now();
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

    // Schedule/manual firings block on any active run of the automation; event
    // firings block per concurrency key (an automation-wide guard would
    // serialize unrelated events, e.g. PR #42 against PR #43).
    const overlapScope: InvocationOverlapScope =
      source === "event" && concurrencyKey !== null
        ? { kind: "concurrencyKey", concurrencyKey }
        : { kind: "automation" };

    // Cheap pre-check; the conditional insert below re-applies the same predicate
    // atomically, so a race here only costs a wasted child build.
    const activeRun =
      overlapScope.kind === "concurrencyKey"
        ? await store.getActiveRunForKey(automation.id, concurrencyKey)
        : await store.getActiveRunForAutomation(automation.id);
    if (activeRun) {
      return this.recordOverlapSkip(store, params, { advanceSchedule: true });
    }

    const [selection, environmentSelection] = await Promise.all([
      params.repositories ?? store.getRepositoriesForAutomation(automation.id),
      params.environments ?? store.getEnvironmentsForAutomation(automation.id),
    ]);
    // One snapshot of the owning team classifies denials and pins the grants version.
    const team =
      automation.owner_team_id === null
        ? null
        : await new TeamStore(this.db).getById(automation.owner_team_id);
    const authorization: AutomationExecutionAuthorizationRequest = {
      automationId: automation.id,
      executionUserId: executionPrincipal.platformUserId,
      requiresRepositoryUse: selection.length > 0,
      requiresEnvironmentUse: environmentSelection.length > 0,
    };
    if (!(await isAutomationExecutionAuthorized(this.db, authorization))) {
      return { outcome: "unauthorized", reason: executionDenialReason(team) };
    }
    const resolutions = await resolveAutomationRepositories(this.env, selection);
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

    const invocationId = params.invocationId ?? generateId();
    const scheduledAt = params.scheduledAt ?? now;

    const childBase = () => ({
      id: generateId(),
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
    let teamGrantsVersion: { teamId: string; version: number } | undefined;
    if (automation.owner_team_id !== null) {
      if (!team) return { outcome: "unauthorized", reason: "execution_authorization_denied" };
      // Snapshot the grants version before checking coverage; the guarded insert
      // refuses admission if grants change in between.
      teamGrantsVersion = { teamId: team.id, version: team.grantsVersion };
      launchTargets = await this.resolveLaunchTargets(automation, launchCandidates);
      if (
        !(await new TeamRepositoryGrantStore(this.db).covers(
          team.id,
          launchTargetRepoIds(launchTargets)
        ))
      ) {
        return { outcome: "unauthorized", reason: "target_team_missing_grant" };
      }
    }
    // Resolve provider routing before admission, alongside the already-built
    // target children. Together these values are the immutable launch snapshot
    // for this firing: edits made after the conditional insert cannot change which
    // account an admitted child uses.
    let providerAuthSnapshot:
      { providerAuth: SessionModelProviderAuthInput[] } | { error: unknown } = { providerAuth: [] };
    if (launchCandidates.length > 0) {
      try {
        const harness = getValidHarnessOrDefault(automation.harness);
        const providerAuth = await resolveAutomationProviderAuth(this.db, automation.id, harness);
        await validateHarnessExecution(
          this.db,
          this.env,
          { harness, model: automation.model, reasoningEffort: automation.reasoning_effort },
          Object.fromEntries(providerAuth.map((auth) => [auth.provider, auth.authMode]))
        );
        providerAuthSnapshot = { providerAuth };
      } catch (error) {
        providerAuthSnapshot = { error };
      }
    }

    const invocation: AutomationInvocationRow = {
      id: invocationId,
      automation_id: automation.id,
      source,
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
        if (source === "schedule" && params.advanceToNextRunAt !== undefined) {
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
      const current = await new TeamStore(this.db).getById(teamGrantsVersion.teamId);
      if (current?.grantsVersion !== teamGrantsVersion.version) {
        // Grants changed after coverage was checked. Nothing was recorded or
        // advanced, so a schedule slot refires and re-authorizes on the next tick.
        return { outcome: "blocked", reason: "team_grants_changed" };
      }
    }
    if (!inserted) {
      // Raced an active invocation between the pre-check and the batch. The
      // batch's schedule advance already ran (deliberately unconditional), so
      // the skip record must not advance again.
      return this.recordOverlapSkip(store, params, { advanceSchedule: false });
    }

    if (params.webhookFollowUpClaimId && triggerKey) {
      try {
        await store.acceptFollowUpReceipt(
          automation.id,
          triggerKey,
          params.webhookFollowUpClaimId,
          invocationId,
          Date.now()
        );
      } catch (error) {
        // The invocation's unique trigger key is already the durable owner; receipt repair
        // must not strand its admitted children before launch.
        this.log.warn("Failed to finalize an admitted webhook follow-up receipt", {
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
        executionPrincipal.scmEnrichment = await this.resolveScmEnrichment(
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
        this.log.warn("Failed to resolve lazy instructions; using fallback", {
          event: "scheduler.instructions_override_failed",
          automation_id: automation.id,
          invocation_id: invocationId,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    const launchChild = async (child: AutomationRunRow): Promise<void> => {
      try {
        if (attributionError !== undefined) throw attributionError;
        if ("error" in providerAuthSnapshot) throw providerAuthSnapshot.error;
        const targetSnapshot = launchTargets.get(child.id);
        if (targetSnapshot && "error" in targetSnapshot) throw targetSnapshot.error;
        const sessionId = generateId();
        // Claim the generated session before initialization. Otherwise the orphan sweep can
        // terminalize an old `starting` row while initialization is still creating its session.
        // The deadline claimed here is the deployment-wide one; session creation replaces it
        // with the budget this session's own settings resolve to. If the worker dies in
        // between, the run stays covered by the shorter of the two, which is what a launch
        // that never finished deserves.
        const claimedAt = Date.now();
        const claimed = await store.claimRunSession(
          child.id,
          sessionId,
          claimedAt,
          claimedAt + this.executionDeadlineMs(DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS)
        );
        if (!claimed) {
          throw new Error("Automation run was recovered before launch claimed its session");
        }
        await this.createSessionForAutomationRun(
          store,
          automation,
          child,
          providerAuthSnapshot.providerAuth,
          sessionId,
          executionPrincipal,
          claimedAt,
          {
            authorization,
            target:
              targetSnapshot && "target" in targetSnapshot ? targetSnapshot.target : undefined,
          }
        );
        await this.sendPromptToSession(
          sessionId,
          automation,
          child.id,
          executionPrincipal,
          instructionsOverride
        );
        child.status = "running";
        child.session_id = sessionId;
        await this.releaseFollowUpsHeldDuringLaunch(store, child);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.log.error("Failed to launch automation run", {
          event: "scheduler.session_creation_failed",
          automation_id: automation.id,
          invocation_id: invocationId,
          run_id: child.id,
          error: message,
        });
        // Losing authorization is not an automation failure: the run is unauthorized, so only
        // genuine sibling failures count a strike. The next admission re-evaluates the
        // principal and pauses if still denied.
        const outcome: Partial<AutomationRunRow> =
          e instanceof AutomationExecutionUnauthorizedError
            ? { status: "unauthorized", failure_reason: e.reason, session_id: null }
            : { status: "failed", failure_reason: message };
        try {
          await store.updateRun(child.id, { ...outcome, completed_at: Date.now() });
        } catch (updateError) {
          this.log.error("Failed to record launch failure", {
            event: "scheduler.fail_track_error",
            automation_id: automation.id,
            run_id: child.id,
            original_reason: message,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
        Object.assign(child, outcome);
      }
    };

    let nextLaunchIndex = 0;
    const launchWorkerCount = Math.min(AUTOMATION_LAUNCH_CONCURRENCY, launchCandidates.length);
    await Promise.all(
      Array.from({ length: launchWorkerCount }, async () => {
        for (;;) {
          const child = launchCandidates[nextLaunchIndex++];
          if (!child) return;
          await launchChild(child);
        }
      })
    );
    const launched = launchCandidates.filter((child) => child.status === "running").length;

    // Pre-failed and launch-failed children have no callback coming — apply
    // the failure strike now (CAS-deduped). This is also the born-terminal
    // path: every repo inaccessible → invocation finalizes immediately.
    if (children.some((child) => child.status === "failed")) {
      try {
        await this.applyInvocationAccounting(store, automation.id, invocationId);
      } catch (e) {
        this.log.error("Failed to apply invocation accounting after launch failures", {
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
   * Record an overlap-blocked firing. Manual firings surface as a 409 with no
   * row; schedule and event firings persist a childless skipped invocation —
   * for schedule slots atomically with the schedule advance (a skip recorded
   * without its advance would re-collide on the same slot every tick). A skip
   * never stores the event trigger_key: a skip must not consume the dedup
   * slot of a firing that never ran.
   */
  private async recordOverlapSkip(
    store: AutomationStore,
    params: StartInvocationParams,
    options: { advanceSchedule: boolean }
  ): Promise<StartInvocationResult> {
    if (params.source === "manual") return { outcome: "blocked", reason: "concurrent_run_active" };

    // A concurrent same-key delivery may have admitted this event since the
    // pre-check; its invocation commits with its active child, so the overlap
    // just observed may be that firing.
    if (params.triggerKey) {
      const ownerId = await store.getInvocationIdByTriggerKey(
        params.automation.id,
        params.triggerKey
      );
      if (ownerId) return { outcome: "deduplicated", invocationId: ownerId };
    }

    const now = Date.now();
    const invocationId = generateId();
    const { inserted } = await store.insertSkippedInvocation(
      {
        id: invocationId,
        automation_id: params.automation.id,
        source: params.source,
        scheduled_at: params.scheduledAt ?? null,
        trigger_key: null,
        concurrency_key: params.concurrencyKey ?? null,
        trigger_metadata: params.triggerMetadata ?? null,
        skip_reason: "concurrent_run_active",
        failure_counted_at: null,
        created_at: now,
        updated_at: now,
      },
      options.advanceSchedule &&
        params.source === "schedule" &&
        params.scheduledAt !== undefined &&
        params.advanceToNextRunAt !== undefined
        ? { fromSlot: params.scheduledAt, nextRunAt: params.advanceToNextRunAt }
        : undefined
    );
    return { outcome: "skipped", invocationId: inserted ? invocationId : null };
  }

  // ─── Tick handler ────────────────────────────────────────────────────────

  async tick(): Promise<SchedulerTickResult> {
    const store = new AutomationStore(this.db);
    const now = Date.now();
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let launchedChildren = 0;

    // 1. Recovery sweeps
    await this.recoverySweep(store);
    await sweepHeldPrompts(this.continuityDeps(store), now);

    // 2. Process overdue automations, bounded by the per-tick child budget.
    const overdue = await store.getOverdueAutomations(now, MAX_PER_TICK);
    const [repositoriesByAutomation, environmentsByAutomation] = await Promise.all([
      store.getRepositoriesForAutomationIds(overdue.map((automation) => automation.id)),
      store.getEnvironmentsForAutomationIds(overdue.map((automation) => automation.id)),
    ]);

    for (const [index, automation] of overdue.entries()) {
      const repositories = repositoriesByAutomation.get(automation.id) ?? [];
      const environments = environmentsByAutomation.get(automation.id) ?? [];
      // Each target — repository or environment — launches one child (a
      // target-less automation launches one null-repo child), so estimate this
      // firing's child count up front and defer whole automations that would
      // push the tick past the budget. Checking before startInvocation
      // prevents the overshoot where a firing materializes and launches up to
      // 10 children before the budget is reconciled. Always admit the first
      // automation so a tick makes progress.
      const estimatedChildren = Math.max(repositories.length + environments.length, 1);
      if (launchedChildren > 0 && launchedChildren + estimatedChildren > TICK_CHILD_LAUNCH_BUDGET) {
        this.log.info("Tick child budget reached; remaining overdue deferred to next tick", {
          event: "scheduler.tick_budget_exhausted",
          launched_children: launchedChildren,
          deferred: overdue.length - index,
        });
        break;
      }
      try {
        const nextRunAt = nextCronOccurrence(
          automation.schedule_cron!,
          automation.schedule_tz
        ).getTime();

        const result = await this.startInvocation(store, {
          automation,
          source: "schedule",
          scheduledAt: automation.next_run_at!,
          advanceToNextRunAt: nextRunAt,
          repositories,
          environments,
        });

        switch (result.outcome) {
          case "started":
            // Summary parity with the pre-invocations tick: a firing that
            // launched nothing (every child pre-failed or failed to launch)
            // reports as failed, not processed.
            if (result.launched > 0) {
              processed++;
            } else if (allRunsUnauthorized(result.runs)) {
              skipped++;
            } else {
              failed++;
            }
            launchedChildren += result.runs.length;
            break;
          case "skipped":
          case "deduplicated":
          case "blocked":
            skipped++;
            break;
          case "unauthorized": {
            const deniedAt = Date.now();
            await store.recordAuthorizationDenied(
              {
                id: generateId(),
                automation_id: automation.id,
                source: "schedule",
                scheduled_at: automation.next_run_at,
                trigger_key: null,
                concurrency_key: null,
                trigger_metadata: null,
                skip_reason: result.reason ?? "execution_authorization_denied",
                failure_counted_at: null,
                created_at: deniedAt,
                updated_at: deniedAt,
              },
              automation.next_run_at!
            );
            this.log.warn("Paused scheduled automation after execution authorization denial", {
              event: "scheduler.authorization_denied",
              automation_id: automation.id,
              scheduled_at: automation.next_run_at,
              reason_code: result.reason ?? "execution_authorization_denied",
            });
            skipped++;
            break;
          }
        }
      } catch (e) {
        this.log.error("Unexpected error processing automation", {
          event: "scheduler.tick_error",
          automation_id: automation.id,
          error: e instanceof Error ? e.message : String(e),
        });
        failed++;
      }
    }

    this.log.info("Tick completed", {
      event: "scheduler.tick_complete",
      processed,
      skipped,
      failed,
      overdue_count: overdue.length,
    });

    return { processed, skipped, failed };
  }

  // ─── Recovery sweep ──────────────────────────────────────────────────────

  private async recoverySweep(store: AutomationStore): Promise<void> {
    const now = Date.now();
    const [orphanedResult, timedOutResult] = await Promise.allSettled([
      store.getOrphanedStartingRuns(ORPHAN_THRESHOLD_MS, RECOVERY_SWEEP_LIMIT),
      // A run claimed by a worker that predates the deadline column carries
      // none; it is held to the deployment-default deadline instead.
      store.getRunsPastExecutionDeadline(
        now,
        this.executionDeadlineMs(DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS),
        RECOVERY_SWEEP_LIMIT
      ),
    ]);

    const orphaned = orphanedResult.status === "fulfilled" ? orphanedResult.value : [];
    const timedOut = timedOutResult.status === "fulfilled" ? timedOutResult.value : [];

    if (orphanedResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query orphaned runs", {
        event: "scheduler.recovery.query_error",
        category: "orphaned",
        error:
          orphanedResult.reason instanceof Error
            ? orphanedResult.reason.message
            : String(orphanedResult.reason),
      });
    }

    if (timedOutResult.status === "rejected") {
      this.log.error("Recovery sweep failed to query timed-out runs", {
        event: "scheduler.recovery.query_error",
        category: "timed_out",
        error:
          timedOutResult.reason instanceof Error
            ? timedOutResult.reason.message
            : String(timedOutResult.reason),
      });
    }

    if (orphaned.length === 0 && timedOut.length === 0) {
      await this.finalizationSweep(store);
      return;
    }

    for (const run of orphaned) {
      this.log.warn("Recovering orphaned starting run", {
        event: "scheduler.recovery.orphaned",
        run_id: run.id,
        automation_id: run.automation_id,
      });
    }
    for (const run of timedOut) {
      this.log.warn("Recovering timed-out running run", {
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
          now
        );
        recoveredRuns.push(...orphaned);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark orphaned runs as failed", {
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
          now
        );
        recoveredRuns.push(...timedOut);
      } catch (e) {
        this.log.error("Recovery sweep failed to mark timed-out runs as failed", {
          event: "scheduler.recovery.bulk_fail_error",
          category: "timed_out",
          count: timedOut.length,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (recoveredRuns.length === 0) {
      await this.finalizationSweep(store);
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
        await this.applyInvocationAccounting(store, automationId, invocationId);
      } catch (e) {
        this.log.error("Recovery sweep failed to track failures", {
          event: "scheduler.recovery.bulk_track_error",
          automation_id: automationId,
          invocation_id: invocationId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await this.finalizationSweep(store);
  }

  /**
   * D2c arm: invocation-level accounting missed in the crash window between a
   * child's terminal update and its callback's accounting — all-terminal
   * invocations with an uncounted failure, and failing automations whose
   * latest invocation may be a fully-completed one (missed reset). Every
   * application goes through the same CAS-guarded, idempotent helper, so
   * overlap with live callbacks is harmless.
   */
  private async finalizationSweep(store: AutomationStore): Promise<void> {
    const since = Date.now() - INVOCATION_SWEEP_WINDOW_MS;
    try {
      const uncounted = await store.getUncountedFailedInvocations(since, RECOVERY_SWEEP_LIMIT);
      for (const invocation of uncounted) {
        await this.applyInvocationAccounting(store, invocation.automation_id, invocation.id);
      }

      const resetCandidates = await store.getStaleFailureResetCandidates(
        since,
        RECOVERY_SWEEP_LIMIT
      );
      for (const candidate of resetCandidates) {
        await this.applyInvocationAccounting(
          store,
          candidate.automation_id,
          candidate.invocation_id
        );
      }
    } catch (e) {
      this.log.error("Invocation finalization sweep failed", {
        event: "scheduler.recovery.finalization_error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ─── Event handler ───────────────────────────────────────────────────────

  /** Match an inbound event to authorized automations and start or steer their invocations. */
  async event(event: AutomationEvent): Promise<SchedulerEventResult> {
    const store = new AutomationStore(this.db);
    return dispatchAutomationEvent(event, {
      continuity: this.continuityDeps(store),
      slack: {
        buildContext: (slackEvent) => this.buildSlackContextWithThread(slackEvent),
        resolveScmEnrichment: (userId) => this.resolveScmEnrichment(userId),
        notifyConcurrencySkip: (slackEvent) => this.notifySlackConcurrencySkip(slackEvent),
      },
      fire: (params) => this.startInvocation(store, params),
    });
  }

  // ─── Manual trigger ──────────────────────────────────────────────────────

  /** Manually trigger an automation under the requesting user's authority. */
  async trigger(
    automationId: string,
    requesterUserId: string,
    requesterEnrichment: GitHubEnrichment | null = null
  ): Promise<SchedulerTriggerResult> {
    const store = new AutomationStore(this.db);
    const automation = await store.getById(automationId);
    if (!automation) {
      throw new Error("Automation not found");
    }

    const result = await this.startInvocation(store, {
      automation,
      source: "manual",
      executionPrincipal: {
        platformUserId: requesterUserId,
        participantUserId: requesterUserId,
        scmEnrichment: requesterEnrichment,
      },
    });

    if (result.outcome === "unauthorized") {
      throw new AutomationExecutionUnauthorizedError(result.reason);
    }
    if (result.outcome === "blocked") throw new AutomationTriggerBlockedError(result.reason);
    if (result.outcome !== "started") {
      // Manual overlap (pre-check or lost race) records nothing.
      throw new AutomationTriggerBlockedError();
    }

    if (allRunsUnauthorized(result.runs)) {
      throw new AutomationExecutionUnauthorizedError(result.runs[0].failure_reason ?? undefined);
    }

    const runs = result.runs.map((run) =>
      toAutomationRun({ ...run, session_title: null, artifact_summary: null })
    );
    if (result.launched === 0) {
      this.log.error("Manual trigger failed", {
        event: "scheduler.manual_trigger_failed",
        automation_id: automationId,
        invocation_id: result.invocationId,
        error: result.runs.find((run) => run.status === "failed")?.failure_reason ?? "unknown",
      });

      throw new Error("Failed to trigger automation");
    }

    this.log.info("Manual trigger succeeded", {
      event: "scheduler.manual_trigger",
      automation_id: automationId,
      invocation_id: result.invocationId,
      launched: result.launched,
    });

    return { invocationId: result.invocationId, runs };
  }

  // ─── Run complete callback ───────────────────────────────────────────────

  async runComplete(body: AutomationRunCompletion): Promise<void> {
    const store = new AutomationStore(this.db);

    const run = await store.getRunById(body.automationId, body.runId);
    if (!run) {
      this.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: "not_found",
      });
      return;
    }

    // The session ran the run's first prompt, so it was queued even if the
    // launching worker died before recording that. The held-prompt sweep then
    // releases follow-ups held during the launch instead of dropping them.
    await store.markRunFirstPromptQueued(body.runId);

    // SQL-guarded transition: only an active run may go terminal. When the
    // guard suppresses the write (recovery sweep or a concurrent callback got
    // there first) the callback is acknowledged as ignored — a terminal child
    // must never transition again.
    const now = Date.now();
    const transitioned = await store.updateRun(
      body.runId,
      body.success
        ? { status: "completed", completed_at: now }
        : {
            status: "failed",
            failure_reason: body.error || "Unknown error",
            completed_at: now,
          }
    );

    // One exception: the sweep's execution timeout is inferred from silence,
    // not observed, so a success that arrives after it is the better record
    // for the run. The correction stops at the run row. The strike the sweep
    // took stays: invocation accounting is unordered, so releasing it here
    // could erase a newer invocation's genuine strike, or race the sweep's own
    // accounting pass into counting a run that is no longer failed. The next
    // fully successful firing resets the streak as it always has.
    const corrected =
      !transitioned && body.success && (await store.completeTimedOutRun(body.runId, now));

    if (corrected) {
      this.log.warn("Run completed after the sweep declared it lost", {
        event: "scheduler.run_complete_corrected",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
        execution_deadline_at: run.execution_deadline_at,
      });
    } else if (!transitioned) {
      this.log.warn("Ignoring run-complete callback for non-active run", {
        event: "scheduler.run_complete_ignored",
        automation_id: body.automationId,
        run_id: body.runId,
        current_status: run.status,
      });
      return;
    }

    // Invocation-level accounting: one CAS-guarded strike per invocation on
    // first failure; streak reset once every sibling completed. Skipped for a
    // correction, per above. The slack fan-out below is not: the sweep posts
    // nothing when it declares a run lost, so returning early here would leave
    // the triggering thread with an `eyes` reaction and no result forever.
    if (!corrected) {
      await this.applyInvocationAccounting(store, body.automationId, run.invocation_id);
    }

    if (body.success) {
      this.log.info("Run completed successfully", {
        event: "scheduler.run_complete",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
      });
    } else {
      this.log.warn("Run completed with failure", {
        event: "scheduler.run_failed",
        automation_id: body.automationId,
        run_id: body.runId,
        session_id: body.sessionId,
        error: body.error,
      });
    }

    // Slack-triggered runs post the agent's result into the triggering message's
    // thread and clear the `eyes` reaction when they finish. The scheduler owns
    // this fan-out (not the session callback path) because the message
    // coordinates live on the invocation. Only the terminal CAS winner owns
    // publication retries; retrying runComplete itself would be ignored.
    await notifySlackCompletion(this.continuityDeps(store), run, body);
  }

  /**
   * Rebuild a Slack event's context block with the thread the message was posted
   * in, asking slack-bot to fetch and render it.
   *
   * Called only after an invocation has been admitted, so the read is paid for
   * exactly when a run will consume it. The bot owns the Slack token and
   * display-name resolution; the scheduler only splices the rendered block into
   * the same layout the ingress path used.
   *
   * Every failure path returns the original context block: thread history is an
   * enhancement and must never prevent a run from starting.
   */
  private async buildSlackContextWithThread(event: SlackAutomationEvent): Promise<string> {
    if (!event.threadTs) return event.contextBlock;

    const binding = this.env.SLACK_BOT;
    const secret = callbackSigningSecret(this.env, "slack-bot");
    if (!binding || !secret) return event.contextBlock;

    try {
      const body = {
        channel: event.channelId,
        threadTs: event.threadTs,
        ts: event.ts,
      };
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/internal/thread-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
        signal: AbortSignal.timeout(SLACK_THREAD_CONTEXT_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.log.warn("Slack thread context request failed", {
          event: "scheduler.slack_thread_context_failed",
          channel: event.channelId,
          http_status: response.status,
        });
        return event.contextBlock;
      }

      const parsed = slackThreadContextResponseSchema.safeParse(await response.json());
      const threadContext = parsed.success ? parsed.data.threadContext : "";
      if (!threadContext) return event.contextBlock;

      return buildSlackContextBlock({
        channelLabel: slackChannelLabel(event.channelId, event.channelName),
        actorUserId: event.actorUserId,
        permalink: event.permalink,
        text: event.text,
        threadContext,
      });
    } catch (error) {
      this.log.warn("Slack thread context request threw", {
        event: "scheduler.slack_thread_context_failed",
        channel: event.channelId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return event.contextBlock;
    }
  }

  /**
   * Post a best-effort ephemeral "a run is already active for this thread"
   * notice to the message author when a slack event is dropped by the
   * per-thread concurrency guard. No-ops without a binding/secret/actor.
   */
  private async notifySlackConcurrencySkip(event: SlackAutomationEvent): Promise<void> {
    const binding = this.env.SLACK_BOT;
    const secret = callbackSigningSecret(this.env, "slack-bot");
    if (!binding || !secret) return;

    const body = buildSlackSkipNotification({
      channelId: event.channelId,
      actorUserId: event.actorUserId,
      threadTs: event.threadTs,
      ts: event.ts,
    });
    if (!body) return;

    try {
      const signature = await computeHmacHex(JSON.stringify(body), secret);
      const response = await binding.fetch("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature }),
      });
      if (!response.ok) {
        this.log.warn("Slack skip callback failed", {
          event: "scheduler.slack_skip_failed",
          channel: event.channelId,
          http_status: response.status,
        });
      }
    } catch (e) {
      this.log.warn("Slack skip callback errored", {
        event: "scheduler.slack_skip_failed",
        channel: event.channelId,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  // ─── Session creation ────────────────────────────────────────────────────

  /**
   * How long after claiming its session the recovery sweep may declare a run
   * lost: the execution budget the session is created with, plus the grace
   * that keeps the session's own watchdog ahead of the sweep.
   */
  private executionDeadlineMs(sandboxSettings: SandboxSettings): number {
    return resolveExecutionBudgetMs(sandboxSettings, this.env) + EXECUTION_DEADLINE_GRACE_MS;
  }

  /**
   * Resolve each launch candidate's session target once, at admission, so grant coverage is
   * checked against exactly what launch will open. Resolution errors become launch failures.
   */
  private async resolveLaunchTargets(
    automation: AutomationRow,
    candidates: readonly AutomationRunRow[]
  ): Promise<ReadonlyMap<string, LaunchTargetSnapshot>> {
    const snapshots = new Map<string, LaunchTargetSnapshot>();
    await Promise.all(
      candidates.map(async (child) => {
        try {
          const target = await resolveAutomationSessionTarget(
            this.env,
            child,
            {
              trace_id: `automation:${automation.id}`,
              request_id: child.id,
              metrics: createRequestMetrics(),
              db: this.db,
              executionCtx: this.backgroundJobs,
            },
            this.log
          );
          snapshots.set(child.id, { target });
        } catch (error) {
          snapshots.set(child.id, { error });
        }
      })
    );
    return snapshots;
  }

  private async createSessionForAutomationRun(
    store: AutomationStore,
    automation: AutomationRow,
    run: AutomationRunRow,
    providerAuth: SessionModelProviderAuthInput[],
    sessionId: string,
    executionPrincipal: ExecutionPrincipal,
    /** The instant the run claimed this session — what its deadline measures from. */
    startedAt: number,
    admission: LaunchAdmission
  ): Promise<void> {
    const ctx: RequestContext = {
      trace_id: `automation:${automation.id}`,
      request_id: run.id,
      metrics: createRequestMetrics(),
      db: this.db,
      executionCtx: this.backgroundJobs,
    };

    if (automation.owner_team_id !== null && !admission.target) {
      throw new Error("Team automation launch is missing its admitted target");
    }
    const target =
      admission.target ?? (await resolveAutomationSessionTarget(this.env, run, ctx, this.log));

    // Session-scoped integration settings resolve from the primary member
    // (design §6.2), with environment-bound runs layering that environment's
    // overrides on top (design §13.5) — same rules as handleCreateSession.
    const scopeMembers =
      target.repositories ??
      (target.repoOwner && target.repoName
        ? [{ repoOwner: target.repoOwner, repoName: target.repoName, repoId: target.repoId }]
        : []);
    const { codeServerEnabled, vncEnabled, sandboxSettings } = await resolveSessionScopedSettings(
      this.db,
      scopeMembers,
      target.environmentId
    );
    // The session below is about to start spending this budget, so the sweep
    // must not come for the run until it is spent.
    await store.setRunExecutionDeadline(
      run.id,
      startedAt + this.executionDeadlineMs(sandboxSettings)
    );
    // Automation runs use all target-applicable shared skills. Personal
    // profiles are interactive-user choices and are not automation policy.
    const managedSkillsManifest = await resolveManagedSkills(
      this.db,
      {
        repositories: scopeMembers,
        environmentId: target.environmentId,
      },
      { mode: "all" },
      executionPrincipal.platformUserId
    );

    const scmEnrichment = executionPrincipal.scmEnrichment;

    // Re-authorize with admission's requirements, and re-read the team's current policy, as the
    // last step before creation: the principal may have left the team, been suspended, or lost a
    // permission, and the team's default visibility may have changed since admission.
    const [team, authorized] = await Promise.all([
      automation.owner_team_id === null
        ? null
        : new TeamStore(this.db).getById(automation.owner_team_id),
      isAutomationExecutionAuthorized(this.db, admission.authorization),
    ]);
    if (!authorized) throw new AutomationExecutionUnauthorizedError(executionDenialReason(team));

    const memorySelection = await createSessionMemorySelector(ctx).select({
      principal: {
        userId: executionPrincipal.platformUserId,
        ownerTeamId: automation.owner_team_id,
      },
      repositories: scopeMembers,
      environmentId: target.environmentId,
    });

    const sessionInput: SessionInitInput = {
      memory: resolvedPin(memorySelection),
      ownerTeamId: automation.owner_team_id,
      visibility: team?.defaultVisibility ?? "workspace",
      sessionId,
      ...target,
      title: `[Auto] ${automation.name}`,
      harness: getValidHarnessOrDefault(automation.harness),
      model: automation.model,
      reasoningEffort: automation.reasoning_effort,
      participantUserId: executionPrincipal.participantUserId,
      platformUserId: executionPrincipal.platformUserId,
      participantCanonicalUserId: executionPrincipal.platformUserId,
      scmUserId: scmEnrichment?.scmUserId,
      scmLogin: scmEnrichment?.scmLogin,
      scmName: scmEnrichment?.displayName,
      scmEmail: scmEnrichment?.email,
      codeServerEnabled,
      vncEnabled,
      sandboxSettings,
      spawnSource: "automation",
      spawnDepth: 0,
      automationId: automation.id,
      automationRunId: run.id,
      managedSkills: resolvedPin(managedSkillsManifest),
      providerAuth,
    };

    await initializeSession(this.env, sessionInput, ctx);
  }

  private continuityDeps(store: AutomationStore): SessionContinuityDeps {
    return {
      store,
      env: this.env,
      log: this.log,
      db: this.db,
      backgroundJobs: this.backgroundJobs,
    };
  }

  /**
   * Follow-ups that continued this run's session while it launched were held so they
   * land after its first prompt, which is now queued. Never throws: the launch itself
   * succeeded, and the held-prompt sweep retries a failed release.
   */
  private async releaseFollowUpsHeldDuringLaunch(
    store: AutomationStore,
    run: AutomationRunRow
  ): Promise<void> {
    try {
      await store.markRunFirstPromptQueued(run.id);
      await releaseHeldPrompts(this.continuityDeps(store), run);
    } catch (error) {
      this.log.error("Failed to release follow-ups held during launch", {
        event: "scheduler.held_prompt_release_failed",
        automation_id: run.automation_id,
        run_id: run.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async sendPromptToSession(
    sessionId: string,
    automation: AutomationRow,
    runId: string,
    executionPrincipal: ExecutionPrincipal,
    instructionsOverride?: string
  ): Promise<void> {
    const callbackContext: AutomationCallbackContext = {
      source: "automation",
      automationId: automation.id,
      runId,
      automationName: automation.name,
    };

    const outcome = await enqueueSessionPrompt(
      this.env,
      sessionId,
      {
        content: instructionsOverride ?? automation.instructions,
        authorId: executionPrincipal.participantUserId,
        canonicalUserId: executionPrincipal.platformUserId,
        source: "automation",
        callbackContext,
        clientRequestId: firstPromptRequestId(runId),
      },
      { trace_id: `automation:${automation.id}`, request_id: runId }
    );
    if (outcome.kind === "rejected") {
      throw new Error(`Prompt enqueue failed with status ${outcome.status}`);
    }
    if (outcome.kind === "request_id_taken") {
      throw new Error("Prompt enqueue was refused: its request id names another prompt");
    }
    // A duplicate means the session already queued this run's first prompt.
  }

  private async resolveScmEnrichment(userId: string): Promise<GitHubEnrichment | null> {
    if (resolveScmProviderFromEnv(this.env.SCM_PROVIDER) !== "github") return null;
    try {
      return await resolveGitHubEnrichmentForCanonicalUser(
        new UserStore(this.db),
        userId,
        () => getUserAuth(this.env, this.db).api
      );
    } catch (error) {
      if (
        !(error instanceof AmbiguousGitHubIdentityError) &&
        !(error instanceof GitHubAttributionUnavailableError)
      )
        throw error;
      this.log.warn("GitHub attribution unavailable; continuing without it", {
        event: "scheduler.github_enrichment_unavailable",
        user_id: userId,
        error,
      });
      return null;
    }
  }
}
