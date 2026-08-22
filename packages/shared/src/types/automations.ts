import { z } from "zod";
import { automationTriggerTypeSchema, triggerConfigSchema } from "../triggers/types";
import {
  MAX_TARGET_REPOSITORIES,
  repositoriesInputSchema,
  repositoryInputSchema,
} from "./repositories";
import type { RepositoryInput, RepositoryRef } from "./repositories";
import { modelProviderSelectionsSchema } from "./provider-accounts";

export type AutomationRunStatus = "starting" | "running" | "completed" | "failed" | "skipped";

export type AutomationInvocationSource = "schedule" | "manual" | "event";

/**
 * Derived from an invocation's child runs — never stored. Zero children ⇔
 * skipped; `partial_failed` means the runs finished terminal with a mix of
 * completed and failed.
 */
export const automationInvocationStatusSchema = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "partial_failed",
  "skipped",
]);

export type AutomationInvocationStatus = z.infer<typeof automationInvocationStatusSchema>;

/** Maximum repositories an automation can fan out across per invocation. */
export const MAX_AUTOMATION_REPOSITORIES = MAX_TARGET_REPOSITORIES;

/** A repository selected on an automation (response shape, resolved). */
const automationRepositorySchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  repoId: z.number().nullable(),
  baseBranch: z.string().nullable(),
});

export type AutomationRepository = z.infer<typeof automationRepositorySchema>;

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

const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  triggerType: automationTriggerTypeSchema,
  scheduleCron: z.string().nullable(),
  scheduleTz: z.string(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  consecutiveFailures: z.number(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
  eventType: z.string().nullable(),
  triggerConfig: triggerConfigSchema.nullable(),
  repositories: z.array(automationRepositorySchema),
  environmentIds: z.array(z.string()),
  providerSelections: modelProviderSelectionsSchema,
});

export type Automation = z.infer<typeof automationSchema>;

const automationExecutionSummarySchema = z.object({
  id: z.string(),
  status: automationInvocationStatusSchema,
  createdAt: z.number(),
});

export type AutomationExecutionSummary = z.infer<typeof automationExecutionSummarySchema>;

const automationListItemSchema = automationSchema.extend({
  recentExecutions: z.array(automationExecutionSummarySchema),
});

export type AutomationListItem = z.infer<typeof automationListItemSchema>;

export const createAutomationRequestSchema = z.object({
  name: z.string(),
  instructions: z.string(),
  triggerType: automationTriggerTypeSchema.optional(),
  scheduleCron: z.string().optional(),
  scheduleTz: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  eventType: z.string().optional(),
  triggerConfig: triggerConfigSchema.optional(),
  sentryClientSecret: z.string().optional(),
  /** Repositories to run against (0..MAX_AUTOMATION_REPOSITORIES). */
  repositories: automationRepositoriesInputSchema.optional(),
  /** Environments to fan out over, one workspace session each (design §13.3). */
  environmentIds: z.array(z.string()).optional(),
  /** Complete pin set. Omission creates the automation without pins. */
  providerSelections: modelProviderSelectionsSchema.optional(),
});
export type CreateAutomationRequest = z.input<typeof createAutomationRequestSchema>;

export const updateAutomationRequestSchema = z.object({
  name: z.string().optional(),
  instructions: z.string().optional(),
  scheduleCron: z.string().optional(),
  scheduleTz: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  eventType: z.string().optional(),
  triggerConfig: triggerConfigSchema.optional(),
  /** Replaces the full repository selection when present. */
  repositories: automationRepositoriesInputSchema.optional(),
  /** Replaces the full environment selection when present (empty clears). */
  environmentIds: z.array(z.string()).optional(),
  /** Replaces every provider pin when present; an empty map clears all pins. */
  providerSelections: modelProviderSelectionsSchema.optional(),
});
export type UpdateAutomationRequest = z.input<typeof updateAutomationRequestSchema>;

export interface AutomationRun {
  id: string;
  automationId: string;
  /** The firing this run belongs to. */
  invocationId: string;
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

export const listAutomationsResponseSchema = z.discriminatedUnion("hasMore", [
  z.object({
    automations: z.array(automationListItemSchema),
    hasMore: z.literal(false),
    nextCursor: z.null(),
  }),
  z.object({
    automations: z.array(automationListItemSchema),
    hasMore: z.literal(true),
    nextCursor: z.string().min(1),
  }),
]);

export type ListAutomationsResponse = z.infer<typeof listAutomationsResponseSchema>;

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
