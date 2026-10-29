import type { AutomationRow, AutomationRunRow } from "../db/automation-store";
import type { AutomationExecutionAuthorizationRequest } from "../automation/authorization-guard";
import type { AutomationSessionTarget } from "../automation/session-target";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { GitHubEnrichment } from "../session/identity";

export interface ExecutionPrincipal {
  platformUserId: string;
  participantUserId: string;
  scmEnrichment: GitHubEnrichment | null;
}

/** What admission decided for a firing, re-checked as each child launches. */
export interface LaunchAdmission {
  authorization: AutomationExecutionAuthorizationRequest;
  /** Session target resolved at admission; required for team automations. */
  target?: AutomationSessionTarget;
}

/** A launch candidate's target as resolved at admission, or why it could not be resolved. */
export type LaunchTargetSnapshot = { target: AutomationSessionTarget } | { error: unknown };

/** Provider routing resolved at admission, or why the automation's harness cannot run. */
export type ProviderAuthSnapshot =
  { providerAuth: SessionModelProviderAuthInput[] } | { error: unknown };

/** What a run's launch uses, settled when its firing (or retry) was admitted. */
export interface RunLaunch {
  executionPrincipal: ExecutionPrincipal;
  authorization: AutomationExecutionAuthorizationRequest;
  providerAuthSnapshot: ProviderAuthSnapshot;
  /** Team automations' session targets, keyed by run id. */
  targets: ReadonlyMap<string, LaunchTargetSnapshot>;
  instructionsOverride?: string;
  /** Fails the launch before it claims a session, e.g. unavailable SCM attribution. */
  launchError?: unknown;
  /**
   * A failure before the prompt is sent may wait and relaunch: scheduled firings of an
   * automation that allowed retries when admitted, and the retries themselves.
   */
  retryable: boolean;
}

export interface CreateAutomationSessionInput {
  automation: AutomationRow;
  run: AutomationRunRow;
  sessionId: string;
  providerAuth: SessionModelProviderAuthInput[];
  executionPrincipal: ExecutionPrincipal;
  /** The session claim time, which its execution deadline measures from. */
  startedAtMs: number;
  admission: LaunchAdmission;
}

export interface FirstPromptInput {
  sessionId: string;
  automation: AutomationRow;
  runId: string;
  executionPrincipal: ExecutionPrincipal;
  instructionsOverride?: string;
}
