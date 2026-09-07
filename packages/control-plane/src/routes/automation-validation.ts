/**
 * Request validation and target selection shared by the automation create and update routes.
 */

import {
  validateConditions,
  conditionRegistry,
  isGitHubConditionSupported,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
} from "@open-inspect/shared/triggers";
import type { AutomationTriggerType, TriggerConfig } from "@open-inspect/shared/triggers";
import { createAutomationRequestSchema } from "@open-inspect/shared/types/automations";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { isValidReasoningEffort } from "@open-inspect/shared/models";
import { type AutomationRepositoryInsert } from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import { MAX_AUTOMATION_REPOSITORIES } from "@open-inspect/shared/types/automations";
import { type RequestContext, json, resolveRepoOrError } from "./shared";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { z } from "zod";
import { createLogger } from "../logger";

const logger = createLogger("router:automations");

export function requireTargetPermissions(
  ctx: RequestContext,
  requiredPermissions: readonly PermissionId[]
): Response | null {
  const authorization = ctx.authorization;
  if (!authorization) return json({ error: "Authorization unavailable" }, 503);
  const missingPermission = requiredPermissions.find(
    (permission) => !authorization.permissions.includes(permission)
  );
  if (missingPermission) {
    return json(
      { error: "Forbidden", code: "permission_required", permission: missingPermission },
      403
    );
  }
  return null;
}

/** Minimum cron interval in minutes. */
export const MIN_CRON_INTERVAL_MINUTES = 15;

/** Maximum name length. */
export const MAX_NAME_LENGTH = 200;

/** Maximum instructions length. Keep in sync with INSTRUCTIONS_MAX_LENGTH in packages/web/src/components/automations/automation-form.tsx. */
export const MAX_INSTRUCTIONS_LENGTH = 15_000;

export const createAutomationBodySchema = createAutomationRequestSchema.extend({
  // Bot-asserted actor display fields are cosmetic only; identity enforcement
  // still runs against the raw pre-Zod body before these parsed values are used.
  actorDisplayName: z.string().optional(),
  actorEmail: z.string().optional(),
  actorAvatarUrl: z.string().optional(),
});

export type CreateAutomationBody = z.infer<typeof createAutomationBodySchema>;

export function formatAutomationRequestError(parseError: z.ZodError, rawBody: unknown): string {
  const issue = parseError.issues[0];
  const field = issue?.path[0];

  if (field === "environmentIds") {
    return issue.message === "must not contain duplicates"
      ? "environmentIds must not contain duplicates"
      : "environmentIds must be an array of environment ids (env_…)";
  }

  if (field === "repositories") {
    const index = typeof issue.path[1] === "number" ? `[${String(issue.path[1])}]` : "";
    return `repositories${index}: ${issue.message}`;
  }

  if (field === "eventType") return "eventType must be a non-empty string";

  if (field === "triggerConfig") {
    if (issue.path.length === 2 && issue.path[1] === "conditions") {
      return "triggerConfig.conditions must be an array";
    }

    const path = issue.path.map(String).join(".");
    const conditionIndex = issue.path[1] === "conditions" ? issue.path[2] : undefined;
    const conditions =
      rawBody &&
      typeof rawBody === "object" &&
      "triggerConfig" in rawBody &&
      rawBody.triggerConfig &&
      typeof rawBody.triggerConfig === "object" &&
      "conditions" in rawBody.triggerConfig &&
      Array.isArray(rawBody.triggerConfig.conditions)
        ? rawBody.triggerConfig.conditions
        : undefined;
    const condition = typeof conditionIndex === "number" ? conditions?.[conditionIndex] : undefined;
    const conditionType =
      condition &&
      typeof condition === "object" &&
      "type" in condition &&
      typeof condition.type === "string"
        ? `${condition.type}: `
        : "";
    return `${path}: ${conditionType}${issue.message}`;
  }

  return "Invalid automation request";
}

interface TriggerConditionError {
  condition: TriggerConfig["conditions"][number];
  code: "event_incompatible" | "invalid";
  message: string;
}

export function getTriggerConditionErrors(
  triggerType: AutomationTriggerType,
  triggerConfig: TriggerConfig,
  eventType?: string
): TriggerConditionError[] {
  const source = TRIGGER_TYPE_TO_SOURCE[triggerType];
  if (!source) return [];
  return triggerConfig.conditions.flatMap((condition) => {
    const code =
      source === "github" &&
      eventType !== undefined &&
      !isGitHubConditionSupported(eventType, condition.type)
        ? "event_incompatible"
        : "invalid";
    return validateConditions([condition], source, conditionRegistry, eventType).map((message) => ({
      condition,
      code,
      message,
    }));
  });
}

export function consumeCondition(
  triggerConfig: TriggerConfig,
  condition: TriggerConditionError["condition"],
  consumedIndexes: Set<number>
): boolean {
  const serialized = JSON.stringify(condition);
  const index = triggerConfig.conditions.findIndex(
    (existing, candidateIndex) =>
      !consumedIndexes.has(candidateIndex) && JSON.stringify(existing) === serialized
  );
  if (index === -1) return false;
  consumedIndexes.add(index);
  return true;
}

export function getTriggerEventTypeError(
  triggerType: AutomationTriggerType,
  eventType: unknown
): string | null {
  if (eventType !== undefined && (typeof eventType !== "string" || eventType.trim().length === 0)) {
    return "eventType must be a non-empty string";
  }

  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  if (!source?.supportsEventTypes) return null;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return `eventType is required for ${triggerType} triggers`;
  }
  if (!source.eventTypes.some((candidate) => candidate.eventType === eventType)) {
    return `Unsupported eventType for ${triggerType}: ${eventType}`;
  }
  return null;
}

/** Warn if next run is more than 31 days away. */
export const FAR_FUTURE_THRESHOLD_MS = 31 * 24 * 60 * 60 * 1000;

export function resolveReasoningEffort(
  model: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (reasoningEffort === undefined || reasoningEffort === null) return null;
  return isValidReasoningEffort(model, reasoningEffort) ? reasoningEffort : null;
}

type NormalizedRepositoryInput = NonNullable<CreateAutomationBody["repositories"]>[number];

type RepositorySelectionRequest =
  | { kind: "unchanged" }
  | { kind: "replace"; repositories: NormalizedRepositoryInput[] };

/**
 * Thrown when selection semantics cannot be satisfied. Route handlers catch it
 * and answer 400 while request shape validation remains in the shared schemas.
 */
export class TargetSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetSelectionError";
  }
}

/**
 * Select the repositories from an already-parsed create/update body. `unchanged`
 * means the body did not touch the selection (create treats that as empty).
 */
export function getRepositorySelection(body: {
  repositories?: NormalizedRepositoryInput[];
}): RepositorySelectionRequest {
  if (body.repositories === undefined) return { kind: "unchanged" };
  return { kind: "replace", repositories: body.repositories };
}

/**
 * Target-count rules across BOTH selections (repositories + environments):
 * repo-scoped event triggers need exactly one repository and no environments;
 * fan-out over several targets is a schedule/manual-only product scope (event
 * fan-out semantics are undefined, not technically prevented). Repositories
 * and environments share one combined cap.
 */
export function validateTargetCounts(
  triggerType: AutomationTriggerType,
  repositoryCount: number,
  environmentCount: number
): void {
  if (triggerType === "github_event" || triggerType === "linear_event") {
    if (repositoryCount === 0) {
      throw new TargetSelectionError("Repository-scoped triggers require exactly one repository");
    }
    if (environmentCount > 0) {
      throw new TargetSelectionError("Repository-scoped triggers cannot target environments");
    }
  }
  if (repositoryCount + environmentCount > 1 && triggerType !== "schedule") {
    throw new TargetSelectionError("Multi-target selections require a schedule trigger");
  }
  if (repositoryCount + environmentCount > MAX_AUTOMATION_REPOSITORIES) {
    throw new TargetSelectionError(
      `At most ${MAX_AUTOMATION_REPOSITORIES} repositories and environments combined`
    );
  }
}

type EnvironmentSelectionRequest =
  | { kind: "unchanged" }
  | { kind: "replace"; environmentIds: string[] };

/**
 * Select the environments from an already-parsed create/update body (design
 * §13.3). `unchanged` means the body did not touch the selection (create treats
 * that as empty); an array replaces it wholesale (empty clears).
 */
export function getEnvironmentSelection(body: {
  environmentIds?: string[];
}): EnvironmentSelectionRequest {
  if (body.environmentIds === undefined) return { kind: "unchanged" };
  return { kind: "replace", environmentIds: body.environmentIds };
}

/**
 * Verify every selected environment exists — a selection must not silently
 * point at deleted environments.
 *
 * @throws TargetSelectionError naming every missing environment.
 */
export async function resolveEnvironmentSelection(
  db: SqlDatabase,
  environmentIds: string[]
): Promise<void> {
  if (environmentIds.length === 0) return;
  const store = new EnvironmentStore(db);
  const found = await Promise.all(environmentIds.map((id) => store.getById(id)));
  const missing = environmentIds.filter((_, index) => !found[index]);
  if (missing.length > 0) {
    throw new TargetSelectionError(`Environment not found: ${missing.join(", ")}`);
  }
}

/**
 * Resolve every requested repository through the SCM provider concurrently.
 * The first failure IN INPUT ORDER wins. A repo change always takes the body
 * branch or the freshly resolved default — never a previous row's branch.
 */
export async function resolveRepositorySelection(
  env: Env,
  repositories: NormalizedRepositoryInput[],
  ctx: RequestContext
): Promise<AutomationRepositoryInsert[]> {
  const settled = await Promise.allSettled(
    repositories.map((repository) =>
      resolveRepoOrError(env, repository.repoOwner, repository.repoName, ctx, logger)
    )
  );
  const resolved = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

  return repositories.map((repository, index) => {
    const access = resolved[index];
    return {
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      repo_id: access.repoId,
      base_branch: repository.baseBranch ?? access.defaultBranch,
    };
  });
}

/**
 * Validate an IANA timezone string.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Extract the watched channel IDs from a slack automation's `slack_channel` condition. */
export function extractSlackChannels(triggerConfig: TriggerConfig | null | undefined): string[] {
  for (const condition of triggerConfig?.conditions ?? []) {
    if (condition.type === "slack_channel") return condition.value;
  }
  return [];
}

/**
 * Validate a slack_event trigger config before persistence. It must be scoped to
 * an explicit channel set (net-new validation; the engine otherwise skips
 * condition validation entirely when none are present). A text_match is optional
 * — without one the automation fires on every message in the watched channel.
 * Returns an error message, or null when valid.
 */
export function validateSlackTriggerConfig(
  triggerConfig: TriggerConfig | null | undefined
): string | null {
  const conditions = triggerConfig?.conditions ?? [];
  if (!conditions.some((c) => c.type === "slack_channel")) {
    return "slack_event triggers require a slack_channel condition";
  }
  return null;
}
