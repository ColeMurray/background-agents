import type { TriggerConfig } from "../triggers/conditions";
import {
  MAX_TARGET_REPOSITORIES,
  repositoriesInputSchema,
  repositoryInputSchema,
} from "./repositories";
import type { RepositoryInput, RepositoryRef } from "./repositories";

export type AutomationTriggerType =
  | "schedule"
  | "github_event"
  | "linear_event"
  | "sentry"
  | "webhook"
  | "slack_event";

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

export type AutomationInvocationSource = "schedule" | "manual" | "event";

/**
 * Derived from an invocation's child runs — never stored. Zero children ⇔
 * skipped; `partial_failed` means the runs finished terminal with a mix of
 * completed and failed.
 */
export type AutomationInvocationStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "partial_failed"
  | "skipped";

/** Maximum repositories an automation can fan out across per invocation. */
export const MAX_AUTOMATION_REPOSITORIES = MAX_TARGET_REPOSITORIES;

/** A repository selected on an automation (response shape, resolved). */
export interface AutomationRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string | null;
}

/**
 * Convert a resolved automation-shaped repository into a RepositoryRef.
 * Throws when repoId is missing — refs are the fully-resolved flavor.
 */
export function toRepositoryRef(
  repo: AutomationRepository,
  fallbackBaseBranch = "main"
): RepositoryRef {
  if (repo.repoId == null) {
    throw new Error(`repository ${repo.repoOwner}/${repo.repoName} is not resolved (no repoId)`);
  }
  return {
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
    repoId: repo.repoId,
    baseBranch: repo.baseBranch ?? fallbackBaseBranch,
  };
}

// Aliases: the input schemas are target-agnostic (defined with the repository
// list contracts above); existing automation imports keep working.
export const automationRepositoryInputSchema = repositoryInputSchema;
export type AutomationRepositoryInput = RepositoryInput;
export const automationRepositoriesInputSchema = repositoriesInputSchema;

export interface Automation {
  id: string;
  name: string;
  instructions: string;
  triggerType: AutomationTriggerType;
  scheduleCron: string | null;
  scheduleTz: string;
  model: string;
  reasoningEffort: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  eventType: string | null;
  triggerConfig: TriggerConfig | null;
  /** Selected repositories (0..MAX_AUTOMATION_REPOSITORIES); the canonical repo representation. */
  repositories: AutomationRepository[];
  /**
   * Selected environments (design §13.3): each firing fans out one session
   * per environment, opening that environment's full workspace, alongside the
   * per-repository sessions. Repositories and environments share the combined
   * MAX_AUTOMATION_REPOSITORIES target cap.
   */
  environmentIds: string[];
}

export interface CreateAutomationRequest {
  name: string;
  instructions: string;
  triggerType?: AutomationTriggerType;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  sentryClientSecret?: string;
  /** Repositories to run against (0..MAX_AUTOMATION_REPOSITORIES). */
  repositories?: AutomationRepositoryInput[];
  /** Environments to fan out over, one workspace session each (design §13.3). */
  environmentIds?: string[];
}

export interface UpdateAutomationRequest {
  name?: string;
  instructions?: string;
  scheduleCron?: string;
  scheduleTz?: string;
  model?: string;
  reasoningEffort?: string | null;
  eventType?: string;
  triggerConfig?: TriggerConfig;
  /** Replaces the full repository selection when present. */
  repositories?: AutomationRepositoryInput[];
  /** Replaces the full environment selection when present (empty clears). */
  environmentIds?: string[];
}

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The firing this run belongs to. Never null after the 0030 backfill. */
  invocationId: string | null;
  sessionId: string | null;
  status: AutomationRunStatus;
  skipReason: string | null;
  failureReason: string | null;
  scheduledAt: number;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  sessionTitle: string | null;
  artifactSummary: string | null;
  /**
   * Repository snapshot taken at firing time — history never depends on the
   * live selection. Null for repo-less runs and legacy session-less rows.
   */
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  baseBranch: string | null;
  /**
   * Environment snapshot taken at firing time; the run's session opens this
   * environment's workspace. Null for repository and repo-less runs.
   */
  environmentId: string | null;
}

export interface ListAutomationsResponse {
  automations: Automation[];
  total: number;
}

/**
 * One firing of an automation: 0 runs when skipped, else one run per target —
 * repository or environment — with repo-less automations getting a single run.
 */
export interface AutomationInvocation {
  id: string;
  automationId: string;
  status: AutomationInvocationStatus;
  source: AutomationInvocationSource;
  /** The cron slot this firing served; null for manual/event firings. */
  scheduledAt: number | null;
  /** Non-null ⇔ this firing was skipped (runs is then empty). */
  skipReason: string | null;
  createdAt: number;
  /** Latest child completion; null until all runs are terminal. */
  completedAt: number | null;
  runs: AutomationRun[];
}

export interface ListAutomationInvocationsResponse {
  invocations: AutomationInvocation[];
  /** Counts invocations (each firing is one row regardless of fan-out width). */
  total: number;
}
