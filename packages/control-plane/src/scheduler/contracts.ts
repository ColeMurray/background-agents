/** Public automation scheduler results and errors, independent of its implementation. */
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { AutomationRun } from "@open-inspect/shared/types/automations";
import type { InvocationActorKind } from "../db/automation-store";
import type { GitHubEnrichment } from "../session/identity";
import type { AutomationTriggerBlockedReason } from "./invocation-outcome";
import type { ContinuationOutcome } from "./session-continuity";

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

/** Who fires a manual run, and with what authority. */
export interface ManualTriggerRequester {
  /** The canonical user whose authority executes the run. */
  userId: string;
  scmEnrichment: GitHubEnrichment | null;
  /**
   * Who authored the firing, recorded on its invocation. Separate from `userId`: a credential
   * acting as a user does not establish that a person fired the run.
   */
  actorKind: InvocationActorKind;
  /**
   * Permissions the admitted request may exercise. Execution then needs each permission it uses
   * both here and in the user's live role; absent, the live role alone decides.
   */
  permissionCeiling?: readonly PermissionId[];
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

/**
 * Raised when the session a webhook sessionKey continues does not take the follow-up.
 * The sender sees the refusal instead of the delivery starting over in a fresh session.
 */
export class SessionFollowUpRefusedError extends Error {
  readonly invocationId: string;
  /** The session's response status; null when it could not be reached. */
  readonly status: number | null;
  readonly code: string | null;

  constructor(refusal: Extract<ContinuationOutcome, { kind: "refused" }>) {
    super(
      refusal.status === null
        ? "The session could not be reached for this follow-up"
        : `The session refused this follow-up with status ${refusal.status}`
    );
    this.name = "SessionFollowUpRefusedError";
    this.invocationId = refusal.invocationId;
    this.status = refusal.status;
    this.code = refusal.code;
  }
}
