/**
 * Request validation and target selection shared by the automation create and update routes.
 */

import { hasValidSlackChannelCondition, triggerSources } from "@open-inspect/shared/triggers";
import type { AutomationTriggerType, TriggerConfig } from "@open-inspect/shared/triggers";
import {
  createAutomationRequestSchema,
  validateAutomationTargetCounts,
} from "@open-inspect/shared/types/automations";
import { isValidReasoningEffort } from "@open-inspect/shared/models";
import { type AutomationRepositoryInsert } from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import { TeamMembershipStore } from "../db/team-memberships";
import { checkEnvironmentAccess, type SessionViewer } from "@open-inspect/shared";
import { type RequestContext, error, json, resolveRepoOrError } from "./shared";
import type { RepositoryAuthorizationTarget } from "./workspace-repository-authorization";
import { resolveActiveTeam } from "./team-ownership";
import { automationActionDeniedBody } from "../authorization/owned-resource-admission";
import { authorizeSessionTarget } from "./session-target-authorization";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { z } from "zod";
import { createLogger } from "../logger";

const logger = createLogger("router:automations");

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
  { kind: "unchanged" } | { kind: "replace"; repositories: NormalizedRepositoryInput[] };

/**
 * Selection validation failures carry their HTTP status; request shape
 * validation remains in the shared schemas.
 */
export class TargetSelectionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
    readonly reasonCode?: string
  ) {
    super(message);
    this.name = "TargetSelectionError";
  }

  response(): Response {
    return json(
      {
        error: this.message,
        ...(this.reasonCode ? { code: this.reasonCode, reason_code: this.reasonCode } : {}),
      },
      this.status
    );
  }
}

/** An automation's team, when it has one, must be active and include its executor. */
export async function validateAutomationTeam(
  ctx: RequestContext,
  teamId: string | null,
  executorUserId: string | null
): Promise<Response | null> {
  if (teamId === null) return null;
  const team = await resolveActiveTeam(ctx, teamId);
  if (team instanceof Response) return team;
  return validateTeamExecutor(ctx.db, teamId, executorUserId);
}

/** A team-owned automation's executor must be a canonical member of that team. */
export async function validateTeamExecutor(
  db: SqlDatabase,
  teamId: string,
  executorUserId: string | null
): Promise<Response | null> {
  if (!executorUserId) {
    return json({ error: "Canonical executor required", code: "executor_required" }, 409);
  }
  if (!(await new TeamMembershipStore(db).listForUser(executorUserId)).has(teamId)) {
    return json(automationActionDeniedBody("not_member", "Executor must belong to the team"), 403);
  }
  return null;
}

export async function validateAutomationExecutor(
  db: SqlDatabase,
  userId: string
): Promise<Response | null> {
  const user = z
    .object({ suspended_at: z.number().nullable(), role_id: z.string().nullable() })
    .nullable()
    .parse(
      await db
        .prepare(
          `SELECT u.suspended_at, a.role_id FROM users u
       LEFT JOIN user_role_assignments a ON a.user_id = u.id WHERE u.id = ?`
        )
        .bind(userId)
        .first()
    );
  if (!user) return error("User not found", 404);
  if (user.suspended_at !== null || user.role_id === null) {
    return json(
      { error: "User inactive", code: "user_inactive", reason_code: "user_inactive" },
      409
    );
  }
  return null;
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
  const validationError = validateAutomationTargetCounts(
    triggerType,
    repositoryCount,
    environmentCount
  );
  if (validationError) throw new TargetSelectionError(validationError);
}

type EnvironmentSelectionRequest =
  { kind: "unchanged" } | { kind: "replace"; environmentIds: string[] };

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
 * Verify selected environments are visible, belong to the automation's team, and
 * admit use for replacements. Stored selections still supply the owning team's grant check.
 *
 * @throws TargetSelectionError naming every missing or invisible environment.
 */
export async function resolveEnvironmentSelection(
  db: SqlDatabase,
  environmentIds: string[],
  ownerTeamId: string | null,
  viewer: SessionViewer,
  requireUse = true
): Promise<RepositoryAuthorizationTarget[]> {
  if (environmentIds.length === 0) return [];
  const store = new EnvironmentStore(db);
  const found = await Promise.all(
    environmentIds.map(async (id) => {
      const environment = await store.getById(id);
      if (!environment) return null;
      const access = checkEnvironmentAccess(
        viewer,
        { ownerTeamId: environment.owner_team_id },
        "use"
      );
      if (!access.allowed && access.reason === "not_member") return null;
      return { environment, access };
    })
  );
  const missing = environmentIds.filter((_, index) => !found[index]);
  if (missing.length > 0) {
    throw new TargetSelectionError(`Environment not found: ${missing.join(", ")}`);
  }
  const repositories: RepositoryAuthorizationTarget[] = [];
  for (const target of found) {
    if (!target) continue;
    const { environment, access } = target;
    // Unchanged selections retain their use-permission exemption, not a visibility exemption.
    if (!access.allowed && (requireUse || access.reason !== "missing_permission")) {
      throw new TargetSelectionError("Environment use denied", 403, access.reason);
    }
    if (environment.owner_team_id !== ownerTeamId) {
      throw new TargetSelectionError(
        "Environment must belong to the automation's owner team",
        409,
        "environment_team_mismatch"
      );
    }
    if (ownerTeamId !== null) {
      repositories.push(
        ...(await store.getRepositoriesForEnvironment(environment.id)).map((repository) => ({
          owner: repository.repo_owner,
          name: repository.repo_name,
          repoId: repository.repo_id,
        }))
      );
    }
  }
  return repositories;
}

/**
 * Resolve every requested repository through the SCM provider concurrently.
 * The first failure IN INPUT ORDER wins. A repo change always takes the body
 * branch or the freshly resolved default — never a previous row's branch.
 */
export async function resolveRepositorySelection(
  env: Env,
  repositories: NormalizedRepositoryInput[],
  ctx: RequestContext,
  teamId: string | null
): Promise<AutomationRepositoryInsert[] | Response> {
  const targetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId: null,
    repositories: repositories.map((repository) => ({
      owner: repository.repoOwner,
      name: repository.repoName,
    })),
  });
  if (targetAuthorizationError) return targetAuthorizationError;

  const settled = await Promise.allSettled(
    repositories.map((repository) =>
      resolveRepoOrError(env, repository.repoOwner, repository.repoName, ctx, logger)
    )
  );
  const resolved = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

  const inserts = repositories.map((repository, index) => {
    const access = resolved[index];
    return {
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      repo_id: access.repoId,
      base_branch: repository.baseBranch ?? access.defaultBranch,
    };
  });
  const resolvedTargetAuthorizationError = await authorizeSessionTarget(ctx, {
    teamId,
    repositories: inserts.map((repository) => ({
      owner: repository.repo_owner,
      name: repository.repo_name,
      repoId: repository.repo_id,
    })),
  });
  return resolvedTargetAuthorizationError ?? inserts;
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
  if (!hasValidSlackChannelCondition(conditions)) {
    return "slack_event triggers require a slack_channel condition";
  }
  return null;
}
