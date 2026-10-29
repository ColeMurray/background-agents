/**
 * AutomationStore — D1 persistence for automations and automation runs.
 *
 * Follows the same pattern as SessionIndexStore: constructor takes SqlDatabase,
 * snake_case rows in the database, camelCase types at the API boundary.
 */

import { isWorkspaceAdmin, WORKSPACE_ADMIN_ROLE_KEYS } from "@open-inspect/shared/rbac";
import {
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import type {
  Automation,
  AutomationExecutionSummary,
  AutomationInvocation,
  AutomationInvocationSource,
  AutomationInvocationStatus,
  AutomationRepository,
  AutomationRun,
  AutomationRunStatus,
} from "@open-inspect/shared/types/automations";
import {
  DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS,
  automationInvocationStatusSchema,
} from "@open-inspect/shared/types/automations";
import {
  automationTriggerTypeSchema,
  triggerConfigSchema,
  type AutomationTriggerType,
  type TriggerConfig,
} from "@open-inspect/shared/triggers";
import {
  toProviderSelections,
  type AutomationModelProviderAuthRow,
} from "./automation-model-provider-auth";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { CreatedAtCursor } from "../created-at-cursor";
import { z } from "zod";
import { UserStore } from "./user-store";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import { automationExecutionPredicate } from "../automation/authorization-guard";
import type { SessionViewer } from "@open-inspect/shared";

/** Legacy rows predate canonical executors; their GitHub creator may now map to a user. */
function needsCanonicalOwner(row: AutomationRow): boolean {
  return !row.user_id && !!row.created_by && row.created_by !== "anonymous";
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function appendRepositoryFilter(
  conditions: string[],
  params: unknown[],
  options: { repoOwner?: string; repoName?: string }
): void {
  if (options.repoOwner) {
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_repositories ar
               WHERE ar.automation_id = automations.id AND ar.repo_owner = ?${
                 options.repoName ? " AND ar.repo_name = ?" : ""
               })`
    );
    params.push(options.repoOwner.toLowerCase());
    if (options.repoName) params.push(options.repoName.toLowerCase());
  } else if (options.repoName) {
    conditions.push(
      `EXISTS (SELECT 1 FROM automation_repositories ar
               WHERE ar.automation_id = automations.id AND ar.repo_name = ?)`
    );
    params.push(options.repoName.toLowerCase());
  }
}

// ─── Internal row types ──────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  name: string;
  instructions: string;
  trigger_type: string;
  schedule_cron: string | null;
  schedule_once_at: number | null;
  schedule_tz: string;
  harness: HarnessId;
  model: string;
  reasoning_effort: string | null;
  enabled: number; // SQLite integer boolean
  /** Firings allowed in flight at once; one serializes (the pre-0094 behaviour). */
  max_concurrent_runs: number;
  next_run_at: number | null;
  consecutive_failures: number;
  /**
   * Relaunches allowed for a scheduled run whose launch fails before its prompt is sent.
   * Optional so rows built for insert may omit it; the column defaults to no retries.
   */
  max_retries?: number;
  created_by: string;
  user_id: string | null;
  owner_team_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  event_type: string | null;
  trigger_config: string | null; // JSON-serialized TriggerConfig
  trigger_auth_data: string | null;
}

const automationOwnerRowSchema = z.object({ owner_team_id: z.string().nullable() });

export function withValidatedOwnerTeam(row: AutomationRow): AutomationRow {
  return {
    ...row,
    owner_team_id: automationOwnerRowSchema.parse(row).owner_team_id,
  };
}

type AutomationListResult = { automations: AutomationRow[] } & (
  { hasMore: false; nextCursor: null } | { hasMore: true; nextCursor: CreatedAtCursor }
);

/**
 * Failure reason the recovery sweep writes when a run outlives its execution
 * deadline with no completion callback. Unlike every other terminal state this
 * one is inferred from silence, which is why a late success callback is allowed
 * to overturn it.
 */
export const EXECUTION_TIMEOUT_FAILURE_REASON = "execution_timeout";

/**
 * Statuses of a run that holds its automation, or its event's concurrency key. Inlined as
 * literal SQL so active-run lookups can use idx_runs_active_lookup, whose partial predicate
 * lists the same statuses.
 */
const ACTIVE_RUN_STATUSES_SQL = "('starting', 'running', 'retrying')";

/**
 * The run's automation is live and allows another launch after the run's current attempt.
 * One predicate decides whether a failed launch waits, whether a waiting run may relaunch, and
 * whether it is withdrawn. Correlated on `automation_runs`: statements using it must not alias
 * that table.
 */
const RETRY_ALLOWED_SQL = `EXISTS (
  SELECT 1 FROM automations a
  WHERE a.id = automation_runs.automation_id AND a.enabled = 1 AND a.deleted_at IS NULL
    AND automation_runs.attempt <= a.max_retries
    AND (a.schedule_once_at IS NULL OR a.schedule_once_at = automation_runs.scheduled_at))`;

/** A run the orphan sweep may fail; binds the creation cutoff. */
const ORPHANED_STARTING_RUN_PREDICATE = "status = 'starting' AND created_at < ?";

/** A run the deadline sweep may fail; binds `now`, then `now` less the default deadline. */
const RUN_PAST_EXECUTION_DEADLINE_PREDICATE =
  "status = 'running' AND (execution_deadline_at < ? OR (execution_deadline_at IS NULL AND started_at < ?))";

/** Team grants version a launch's targets were authorized against. */
export interface TeamGrantsVersion {
  teamId: string;
  version: number;
}

/** Refuses an admission write once the team's grants changed from the version checked. */
function teamGrantsGuard(grants: TeamGrantsVersion | undefined): {
  sql: string;
  params: unknown[];
} {
  return grants
    ? {
        sql: "AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND grants_version = ?)",
        params: [grants.teamId, grants.version],
      }
    : { sql: "", params: [] };
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  /** Owning invocation. */
  invocation_id: string;
  session_id: string | null;
  status: AutomationRunStatus;
  skip_reason: string | null;
  failure_reason: string | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  /**
   * When the recovery sweep may declare this run lost, stamped at launch from
   * the execution budget its session was created with. Null until the run
   * claims a session, and on rows that predate the column.
   */
  execution_deadline_at: number | null;
  created_at: number;
  /** Repository snapshot taken at firing time (null for repo-less runs). */
  repo_owner: string | null;
  repo_name: string | null;
  repo_id: number | null;
  base_branch: string | null;
  /** Environment snapshot taken at firing time (null for repository/repo-less runs). */
  environment_id: string | null;
  /**
   * 1 from the session claim until the run's own first prompt is on its session's
   * queue; session continuity holds follow-ups meanwhile. 0 otherwise, including on
   * rows that predate the column.
   */
  first_prompt_pending: number;
  /** Launches so far, counting the current one. Optional on rows built for insert (default 1). */
  attempt?: number;
  /** When a `retrying` run launches again; null otherwise. */
  retry_at?: number | null;
}

export interface ContinuableRunRow extends AutomationRunRow {
  /** The session's latest activity, or the run's creation when it has no session row. */
  last_activity_at: number;
  /** 1 while follow-ups held during the run's launch still await release. */
  has_held_prompts: number;
}

/** {@link AutomationStore.holdPromptForLaunchingRun}: not holding once the run is ready and drained. */
export type HoldPromptResult = "held" | "duplicate" | "not_holding";

/** A continuity follow-up held until its run's first prompt is queued. */
export interface HeldPromptRow {
  id: string;
  run_id: string;
  actor_user_id: string;
  actor_author_id: string;
  /** The prompt's clientRequestId, unique per run. */
  client_request_id: string;
  /** JSON enqueue-prompt request body. */
  prompt: string;
  request_id: string;
  created_at: number;
  /** When the held-prompt sweep next tries to settle the run's held prompts. */
  retry_at: number;
}

export interface EnrichedRunRow extends AutomationRunRow {
  session_title: string | null;
  artifact_summary: string | null;
}

export interface AutomationRepositoryRow {
  automation_id: string;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string | null;
  created_at: number;
  updated_at: number;
}

/** Repository values for insert/replace (timestamps and owner id supplied by the store). */
export type AutomationRepositoryInsert = Pick<
  AutomationRepositoryRow,
  "repo_owner" | "repo_name" | "repo_id" | "base_branch"
>;

export interface AutomationEnvironmentRow {
  automation_id: string;
  environment_id: string;
  created_at: number;
  updated_at: number;
}

/**
 * Who authored the action that started a firing. `system` is the scheduler,
 * which has no author; `unknown` is a source that does not report one. The
 * column has no CHECK, so readers must tolerate kinds a newer worker added.
 */
export type InvocationActorKind = "person" | "bot" | "system" | "unknown";

export interface AutomationInvocationRow {
  id: string;
  automation_id: string;
  source: AutomationInvocationSource;
  actor_kind: InvocationActorKind;
  scheduled_at: number | null;
  trigger_key: string | null;
  concurrency_key: string | null;
  trigger_metadata: string | null;
  skip_reason: string | null;
  failure_counted_at: number | null;
  created_at: number;
  updated_at: number;
}

export type FollowUpReceiptClaim =
  { kind: "claimed" } | { kind: "accepted" | "pending"; invocationId: string };

export interface AutomationTriggerFields {
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
}

export function parseAutomationTriggerFields(
  row: Pick<AutomationRow, "trigger_type" | "trigger_config">
): AutomationTriggerFields {
  return {
    triggerType: automationTriggerTypeSchema.parse(row.trigger_type),
    triggerConfig:
      row.trigger_config === null
        ? null
        : triggerConfigSchema.parse(JSON.parse(row.trigger_config)),
  };
}

const enrichedAutomationInvocationRowSchema = z.object({
  id: z.string(),
  automation_id: z.string(),
  source: z.enum(["schedule", "manual", "event"]),
  scheduled_at: z.number().nullable(),
  skip_reason: z.string().nullable(),
  created_at: z.number(),
  derived_status: automationInvocationStatusSchema,
  derived_completed_at: z.number().nullable(),
});

type EnrichedAutomationInvocationRow = z.infer<typeof enrichedAutomationInvocationRowSchema>;

const countRowSchema = z.object({ count: z.number() });

/**
 * Overlap scope for a new invocation: schedule/manual firings block once the
 * automation already holds `max_concurrent_runs` invocations in flight; event
 * firings block per concurrency key. The bound is not carried here — the
 * predicate reads it from the automation row in the same statement, so a
 * concurrent PATCH cannot be overtaken by a firing holding a stale snapshot.
 */
export type InvocationOverlapScope =
  { kind: "automation" } | { kind: "concurrencyKey"; concurrencyKey: string };

/**
 * A cron slot handover: move the schedule from the slot this firing claimed
 * (`fromSlot`) to its successor. Carrying the claimed slot lets the UPDATE act
 * as a compare-and-set, so only the firing that still owns the slot advances it.
 * A null successor consumes a one-shot slot; it stays enabled until its runs settle.
 */
export interface ScheduleAdvance {
  fromSlot: number;
  nextRunAt: number | null;
}

/** Sibling-run aggregate for one invocation (finalization input). */
export interface InvocationRunAggregate {
  total: number;
  /** Starting, running, or waiting to retry. */
  active: number;
  /** Waiting to retry; also counted in `active`. */
  retrying: number;
  failed: number;
  completed: number;
  skipped: number;
  lastCompletedAt: number | null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function toAutomationRepository(row: AutomationRepositoryRow): AutomationRepository {
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoId: row.repo_id,
    baseBranch: row.base_branch,
  };
}

/** Map an automation row plus its repository and environment rows to the response shape. */
export function toAutomation(
  row: AutomationRow,
  repositoryRows: AutomationRepositoryRow[],
  environmentRows: AutomationEnvironmentRow[],
  providerAuthRows: AutomationModelProviderAuthRow[]
): Automation {
  const { triggerType, triggerConfig } = parseAutomationTriggerFields(row);

  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    triggerType,
    scheduleCron: row.schedule_cron,
    scheduleOnceAt: row.schedule_once_at,
    scheduleTz: row.schedule_tz,
    harness: getValidHarnessOrDefault(row.harness),
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    enabled: row.enabled === 1,
    maxConcurrentRuns: row.max_concurrent_runs,
    nextRunAt: row.next_run_at,
    consecutiveFailures: row.consecutive_failures,
    maxRetries: row.max_retries ?? 0,
    createdBy: row.created_by,
    userId: row.user_id,
    ownerTeamId: row.owner_team_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    eventType: row.event_type ?? null,
    triggerConfig,
    repositories: repositoryRows.map(toAutomationRepository),
    environmentIds: environmentRows.map((environment) => environment.environment_id),
    providerSelections: toProviderSelections(providerAuthRows),
  };
}

export function toAutomationRun(row: EnrichedRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    invocationId: row.invocation_id,
    sessionId: row.session_id,
    status: row.status,
    skipReason: row.skip_reason,
    failureReason: row.failure_reason,
    attempt: row.attempt ?? 1,
    retryAt: row.retry_at ?? null,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    sessionTitle: row.session_title,
    artifactSummary: row.artifact_summary,
    repoOwner: row.repo_owner ?? null,
    repoName: row.repo_name ?? null,
    repoId: row.repo_id ?? null,
    baseBranch: row.base_branch ?? null,
    environmentId: row.environment_id ?? null,
  };
}

// ─── Derived invocation status ───────────────────────────────────────────────
// Single SQL definition (aggregated over an invocation's child runs, aliased
// `r`) with a TS twin below — integration tests assert the two agree. Arms, in
// order: childless ⇒ skipped (new skips are childless; the app enforces
// skip_reason on them); any active child ⇒ starting until any child has left
// 'starting', then running; else any child waiting to relaunch ⇒ retrying;
// all-terminal: all skipped ⇒ skipped (legacy backfilled skip rows), any denied
// child ⇒ unauthorized, no failure ⇒ completed, no success ⇒ failed, otherwise
// partial_failed.

const DERIVED_INVOCATION_STATUS_SQL = `CASE
  WHEN COUNT(r.id) = 0 THEN 'skipped'
  WHEN SUM(CASE WHEN r.status IN ('starting', 'running') THEN 1 ELSE 0 END) > 0 THEN
    CASE
      WHEN SUM(CASE WHEN r.status <> 'starting' THEN 1 ELSE 0 END) = 0 THEN 'starting'
      ELSE 'running'
    END
  WHEN SUM(CASE WHEN r.status = 'retrying' THEN 1 ELSE 0 END) > 0 THEN 'retrying'
  WHEN SUM(CASE WHEN r.status = 'skipped' THEN 1 ELSE 0 END) = COUNT(r.id) THEN 'skipped'
  WHEN SUM(CASE WHEN r.status = 'unauthorized' THEN 1 ELSE 0 END) > 0 THEN 'unauthorized'
  WHEN SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) = 0 THEN 'completed'
  WHEN SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) = 0 THEN 'failed'
  ELSE 'partial_failed'
END`;

/** Derived completion time: latest child completion once all children are terminal. */
const DERIVED_INVOCATION_COMPLETED_AT_SQL = `CASE
  WHEN COUNT(r.id) = 0 THEN NULL
  WHEN SUM(CASE WHEN r.status IN ${ACTIVE_RUN_STATUSES_SQL} THEN 1 ELSE 0 END) > 0 THEN NULL
  ELSE MAX(r.completed_at)
END`;

/** Invocations with derived status/completion; callers append WHERE … GROUP BY i.id. */
const ENRICHED_INVOCATION_SELECT_SQL = `SELECT i.*,
  ${DERIVED_INVOCATION_STATUS_SQL} AS derived_status,
  ${DERIVED_INVOCATION_COMPLETED_AT_SQL} AS derived_completed_at
FROM automation_invocations i
LEFT JOIN automation_runs r ON r.invocation_id = i.id`;

/** Child runs shaped as EnrichedRunRow; callers append WHERE … ORDER BY. */
const INVOCATION_CHILD_RUN_SELECT_SQL = `SELECT r.*, s.title AS session_title, NULL AS artifact_summary
FROM automation_runs r
LEFT JOIN sessions s ON r.session_id = s.id`;

/**
 * TS twin of DERIVED_INVOCATION_STATUS_SQL over a sibling aggregate. Keep the
 * two in lockstep.
 */
/** True when a firing produced children and every one was denied authorization. */
export function allRunsUnauthorized(runs: readonly Pick<AutomationRunRow, "status">[]): boolean {
  return runs.length > 0 && runs.every((run) => run.status === "unauthorized");
}

export function deriveInvocationStatus(counts: {
  total: number;
  active: number;
  failed: number;
  completed: number;
  skipped: number;
  unauthorized: number;
  // Required: distinguishes "starting" from "running". InvocationRunAggregate
  // folds both into `active` and has no `starting`, so it must not be passed here.
  starting: number;
  /** Runs waiting to relaunch, which `active` includes as InvocationRunAggregate's does. */
  retrying: number;
}): AutomationInvocationStatus {
  if (counts.total === 0) return "skipped";
  if (counts.active > counts.retrying) {
    return counts.starting === counts.total ? "starting" : "running";
  }
  if (counts.retrying > 0) return "retrying";
  if (counts.skipped === counts.total) return "skipped";
  if (counts.unauthorized > 0) return "unauthorized";
  if (counts.failed === 0) return "completed";
  if (counts.completed === 0) return "failed";
  return "partial_failed";
}

function toAutomationInvocation(
  row: EnrichedAutomationInvocationRow,
  runs: AutomationRun[]
): AutomationInvocation {
  const skipped = row.skip_reason !== null;
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.derived_status,
    source: row.source,
    scheduledAt: row.scheduled_at,
    skipReason: row.skip_reason,
    createdAt: row.created_at,
    // A childless skip has no children to complete; it is settled at creation.
    completedAt: skipped && runs.length === 0 ? row.created_at : row.derived_completed_at,
    runs,
  };
}

// ─── Store ───────────────────────────────────────────────────────────────────

/** Persists automations, invocations, runs, and composable lifecycle mutations. */
export class AutomationStore {
  constructor(private readonly db: SqlDatabase) {}

  // --- Automation CRUD ---

  /**
   * Prepared INSERT for an automation row. Public so a route can compose it with
   * `SlackChannelStore.bindChannelStatements` into one atomic `db.batch`.
   */
  bindAutomationInsert(row: AutomationRow): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO automations
         (id, name, instructions,
          trigger_type, schedule_cron, schedule_tz, harness, model, reasoning_effort, enabled,
          max_concurrent_runs, next_run_at,
          consecutive_failures, created_by, user_id, created_at, updated_at, deleted_at,
           event_type, trigger_config, trigger_auth_data, owner_team_id, schedule_once_at, max_retries)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.name,
        row.instructions,
        row.trigger_type,
        row.schedule_cron,
        row.schedule_tz,
        row.harness ?? DEFAULT_HARNESS,
        row.model,
        row.reasoning_effort,
        row.enabled,
        row.max_concurrent_runs,
        row.next_run_at,
        row.consecutive_failures,
        row.created_by,
        row.user_id,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.event_type,
        row.trigger_config,
        row.trigger_auth_data,
        row.owner_team_id,
        row.schedule_once_at,
        row.max_retries ?? 0
      );
  }

  async create(row: AutomationRow): Promise<void> {
    await this.bindAutomationInsert(row).run();
  }

  async getById(id: string): Promise<AutomationRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL")
      .bind(id)
      .first<AutomationRow>();
    return row ? withValidatedOwnerTeam(row) : null;
  }

  /**
   * Repair a legacy SCM-only owner with a compare-and-set and return the canonical row.
   * Every ownership admission path calls this before comparing `user_id`, so repair is
   * a storage invariant rather than a side effect of starting an invocation.
   */
  async resolveCanonicalOwner(automation: AutomationRow): Promise<AutomationRow> {
    if (!needsCanonicalOwner(automation)) return automation;

    const identity = await new UserStore(this.db).getIdentity("github", automation.created_by);
    if (!identity) return automation;

    const result = await this.db
      .prepare("UPDATE automations SET user_id = ? WHERE id = ? AND user_id IS NULL")
      .bind(identity.userId, automation.id)
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { ...automation, user_id: identity.userId };
    }
    return (await this.getById(automation.id)) ?? automation;
  }

  /**
   * Project the canonical owner that {@link resolveCanonicalOwner} would repair, for a page of
   * rows in one bounded lookup, so collection capabilities agree with item admission.
   */
  async projectCanonicalOwners(rows: readonly AutomationRow[]): Promise<AutomationRow[]> {
    const legacyCreators = [
      ...new Set(rows.filter(needsCanonicalOwner).map((row) => row.created_by)),
    ];
    const owners = new Map<string, string>();
    for (let offset = 0; offset < legacyCreators.length; offset += MAX_D1_QUERY_PARAMETERS) {
      const chunk = legacyCreators.slice(offset, offset + MAX_D1_QUERY_PARAMETERS);
      const result = await this.db
        .prepare(
          `SELECT provider_user_id, user_id FROM user_identities
           WHERE provider = 'github' AND provider_user_id IN (${chunk.map(() => "?").join(", ")})`
        )
        .bind(...chunk)
        .all<{ provider_user_id: string; user_id: string }>();
      for (const identity of result.results ?? []) {
        owners.set(identity.provider_user_id, identity.user_id);
      }
    }
    return rows.map((row) => {
      const owner = needsCanonicalOwner(row) ? owners.get(row.created_by) : undefined;
      return owner ? { ...row, user_id: owner } : row;
    });
  }

  async list(options: {
    limit: number;
    cursor?: CreatedAtCursor | null;
    nameSearch?: string;
    repoOwner?: string;
    repoName?: string;
    viewer?: SessionViewer;
    teamId?: string | null;
  }): Promise<AutomationListResult> {
    const conditions: string[] = [
      "deleted_at IS NULL",
      // Filter before LIMIT/cursor pagination, using the same status as history.
      // Denials are childless too, but must remain visible for authorization repair.
      `NOT (trigger_type = 'schedule' AND schedule_once_at IS NOT NULL AND enabled = 0
        AND EXISTS (
          SELECT 1 FROM automation_invocations i
          LEFT JOIN automation_runs r ON r.invocation_id = i.id
          WHERE i.automation_id = automations.id AND i.source = 'schedule'
            AND i.scheduled_at = automations.schedule_once_at
            AND (i.skip_reason IS NULL OR i.skip_reason = 'concurrent_run_active')
          GROUP BY i.id
          HAVING ${DERIVED_INVOCATION_STATUS_SQL} IN ('completed', 'skipped')
        )
        AND NOT EXISTS (
          SELECT 1 FROM automation_runs active
          WHERE active.automation_id = automations.id AND active.status IN ${ACTIVE_RUN_STATUSES_SQL}
        ))`,
    ];
    const params: unknown[] = [];

    const viewer = options.viewer;
    if (viewer?.kind === "user") {
      if (viewer.suspended || !viewer.permissions.includes("automations.read")) {
        conditions.push("0 = 1");
      } else if (!isWorkspaceAdmin(viewer.roleKey)) {
        // One bound parameter regardless of how many teams the viewer belongs to.
        conditions.push(
          `(owner_team_id IS NULL OR EXISTS (
             SELECT 1 FROM team_memberships m
             WHERE m.team_id = automations.owner_team_id AND m.user_id = ?))`
        );
        params.push(viewer.userId);
      }
    } else if (viewer?.kind === "service" && viewer.teamId !== null) {
      conditions.push("(owner_team_id IS NULL OR owner_team_id = ?)");
      params.push(viewer.teamId);
    }
    if (options.teamId !== undefined) {
      conditions.push("owner_team_id IS ?");
      params.push(options.teamId);
    }

    if (options.nameSearch) {
      conditions.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push(`%${escapeLikePattern(options.nameSearch)}%`);
    }

    appendRepositoryFilter(conditions, params, options);

    if (options.cursor) {
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const result = await this.db
      .prepare(`SELECT * FROM automations ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...params, options.limit + 1)
      .all<AutomationRow>();

    const rows = (result.results || []).map(withValidatedOwnerTeam);
    const hasMore = rows.length > options.limit;
    const automations = hasMore ? rows.slice(0, options.limit) : rows;
    if (!hasMore) return { automations, hasMore: false, nextCursor: null };
    return {
      automations,
      hasMore: true,
      nextCursor: {
        createdAt: automations[automations.length - 1].created_at,
        id: automations[automations.length - 1].id,
      },
    };
  }

  async listRecentExecutionsForAutomationIds(
    automationIds: string[],
    limit: number
  ): Promise<Map<string, AutomationExecutionSummary[]>> {
    const executionsByAutomation = new Map<string, AutomationExecutionSummary[]>();
    for (const id of automationIds) executionsByAutomation.set(id, []);
    if (automationIds.length === 0) return executionsByAutomation;

    const placeholders = automationIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `WITH ranked_invocations AS (
           SELECT i.id, i.automation_id, i.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY i.automation_id
                    ORDER BY i.created_at DESC, i.id DESC
                  ) AS position
           FROM automation_invocations i
           WHERE i.automation_id IN (${placeholders})
         ),
         recent_invocations AS (
           SELECT id, automation_id, created_at
           FROM ranked_invocations
           WHERE position <= ?
         )
         SELECT i.id, i.automation_id, i.created_at,
                ${DERIVED_INVOCATION_STATUS_SQL} AS derived_status
         FROM recent_invocations i
         LEFT JOIN automation_runs r ON r.invocation_id = i.id
         GROUP BY i.id
         ORDER BY i.automation_id, i.created_at DESC, i.id DESC`
      )
      .bind(...automationIds, limit)
      .all<{
        id: string;
        automation_id: string;
        created_at: number;
        derived_status: AutomationInvocationStatus;
      }>();

    for (const row of result.results ?? []) {
      executionsByAutomation.get(row.automation_id)?.push({
        id: row.id,
        status: row.derived_status,
        createdAt: row.created_at,
      });
    }
    return executionsByAutomation;
  }

  /**
   * Build the dynamic UPDATE statement for the allowed automation fields, or
   * null when `fields` carries nothing to write. Public so a route can compose it
   * with `SlackChannelStore.bindChannelStatements` into one atomic `db.batch`.
   */
  bindAutomationUpdate(id: string, fields: Partial<AutomationRow>): SqlStatement | null {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    // Repository fields are deliberately absent: the selection lives in
    // automation_repositories, written only by bindReplaceRepositories.
    const allowedFields: (keyof AutomationRow)[] = [
      "name",
      "instructions",
      "schedule_cron",
      "schedule_once_at",
      "schedule_tz",
      "harness",
      "model",
      "reasoning_effort",
      "next_run_at",
      "enabled",
      "max_concurrent_runs",
      "consecutive_failures",
      "max_retries",
      "event_type",
      "trigger_config",
      "trigger_auth_data",
    ];

    for (const field of allowedFields) {
      if (field === "next_run_at" && fields.schedule_once_at != null) continue;
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (fields.schedule_once_at != null) {
      // Compute from the live row: a concurrent resume/pause must not strand or re-arm a slot.
      setClauses.push(
        "next_run_at = CASE WHEN schedule_once_at = ? THEN next_run_at WHEN enabled = 1 THEN ? ELSE NULL END"
      );
      params.push(fields.schedule_once_at, fields.schedule_once_at);
    }

    if (setClauses.length === 0) return null;

    setClauses.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);

    return this.db
      .prepare(
        `UPDATE automations SET ${setClauses.join(", ")} WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(...params);
  }

  async update(id: string, fields: Partial<AutomationRow>): Promise<AutomationRow | null> {
    const statement = this.bindAutomationUpdate(id, fields);
    if (statement) await statement.run();
    return this.getById(id);
  }

  /**
   * Reassign the executor only if, at write time, the caller still holds reassignment authority
   * and the candidate can still launch the automation's current targets.
   */
  bindExecutorChange(automation: AutomationRow, userId: string, actorUserId: string): SqlStatement {
    const manageOwn = rolePermissionPredicate("automations.manage.own");
    const manageAny = rolePermissionPredicate("automations.manage.any");
    const execution = automationExecutionPredicate({
      automationId: automation.id,
      executionUserId: userId,
      requiresRepositoryUse: "stored",
      requiresEnvironmentUse: "stored",
    });
    return this.db
      .prepare(
        `UPDATE automations SET user_id = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND user_id IS ? AND owner_team_id IS ?
           AND user_id IS NOT ?
           AND EXISTS (
             SELECT 1 FROM users actor
             JOIN user_role_assignments actor_role ON actor_role.user_id = actor.id
             JOIN roles r ON r.id = actor_role.role_id
             WHERE actor.id = ? AND actor.suspended_at IS NULL
               AND (${manageOwn.sql} OR ${manageAny.sql})
               AND (r.key IN (${WORKSPACE_ADMIN_ROLE_KEYS.map(() => "?").join(", ")}) OR EXISTS (
                 SELECT 1 FROM team_memberships lead_membership
                 WHERE lead_membership.team_id = automations.owner_team_id
                   AND lead_membership.user_id = actor.id AND lead_membership.role = 'lead')))
           AND ${execution.sql}`
      )
      .bind(
        userId,
        Date.now(),
        automation.id,
        automation.user_id,
        automation.owner_team_id,
        userId,
        actorUserId,
        ...manageOwn.values,
        ...manageAny.values,
        ...WORKSPACE_ADMIN_ROLE_KEYS,
        ...execution.values
      );
  }

  /** Build a soft-delete statement for composition in an atomic batch. */
  bindSoftDelete(id: string, now = Date.now()): SqlStatement {
    return this.db
      .prepare(
        "UPDATE automations SET deleted_at = ?, next_run_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(now, now, id);
  }

  /** Soft-delete an automation and report whether a live row changed. */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.bindSoftDelete(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Build a pause statement for composition in an atomic batch. */
  bindPause(id: string, now = Date.now()): SqlStatement {
    return this.db
      .prepare(
        "UPDATE automations SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(now, id);
  }

  /** Pause an automation and report whether a live row changed. */
  async pause(id: string): Promise<boolean> {
    const result = await this.bindPause(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Disable consumed one-shots once all active runs settle. The optional ID scopes live
   * completion; recovery repairs all missed completions. Live SQL guards protect a reschedule
   * or an admitted manual run that races finalization.
   */
  async disableSettledOneShots(automationId?: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE automations SET enabled = 0, updated_at = ?
         WHERE trigger_type = 'schedule' AND schedule_once_at IS NOT NULL
           AND enabled = 1 AND deleted_at IS NULL AND next_run_at IS NULL
           ${automationId === undefined ? "" : "AND id = ?"}
           AND EXISTS (SELECT 1 FROM automation_invocations i
             WHERE i.automation_id = automations.id AND i.source = 'schedule'
               AND i.scheduled_at = automations.schedule_once_at)
           AND NOT EXISTS (SELECT 1 FROM automation_runs r
             WHERE r.automation_id = automations.id AND r.status IN ${ACTIVE_RUN_STATUSES_SQL})`
      )
      .bind(Date.now(), ...(automationId === undefined ? [] : [automationId]))
      .run();
  }

  /** Resume only the observed one-shot slot, so a concurrent reschedule wins. */
  bindResume(id: string, nextRunAt: number | null, now = Date.now()): SqlStatement {
    return this.db
      .prepare(
        `UPDATE automations SET enabled = 1, next_run_at = ?, consecutive_failures = 0, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND (schedule_once_at IS NULL OR schedule_once_at = ?)`
      )
      .bind(nextRunAt, now, id, nextRunAt);
  }

  /** Resume an automation and report whether a live row changed. */
  async resume(id: string, nextRunAt: number | null): Promise<boolean> {
    const result = await this.bindResume(id, nextRunAt).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Advance next_run_at strictly forward. A duplicate cron firing that reaches
   * the dedup path after a newer tick already advanced the schedule must not
   * rewind it — an earlier next_run_at would leave the automation spuriously
   * overdue and fire again. The monotonic guard writes only when the proposed
   * time is later than the stored one (or none is set).
   */
  async advanceNextRunAt(id: string, nextRunAt: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        "UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ? AND (next_run_at IS NULL OR next_run_at < ?)"
      )
      .bind(nextRunAt, now, id, nextRunAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  // --- Repository selection (automation_repositories: single source of truth) ---

  async getRepositoriesForAutomation(automationId: string): Promise<AutomationRepositoryRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_repositories
         WHERE automation_id = ?
         ORDER BY repo_owner, repo_name`
      )
      .bind(automationId)
      .all<AutomationRepositoryRow>();
    return result.results || [];
  }

  /** Batched variant for the tick loop — one query for all overdue automations. */
  async getRepositoriesForAutomationIds(
    automationIds: string[]
  ): Promise<Map<string, AutomationRepositoryRow[]>> {
    const map = new Map<string, AutomationRepositoryRow[]>();
    for (const id of automationIds) map.set(id, []);
    if (automationIds.length === 0) return map;

    const placeholders = automationIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_repositories
         WHERE automation_id IN (${placeholders})
         ORDER BY repo_owner, repo_name`
      )
      .bind(...automationIds)
      .all<AutomationRepositoryRow>();

    for (const row of result.results ?? []) {
      map.get(row.automation_id)?.push(row);
    }
    return map;
  }

  /** INSERT statements for an automation's repository rows (composable into a batch). */
  bindRepositoryInserts(
    automationId: string,
    repositories: AutomationRepositoryInsert[],
    now: number
  ): SqlStatement[] {
    return repositories.map((repository) =>
      this.db
        .prepare(
          `INSERT INTO automation_repositories
           (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          automationId,
          repository.repo_owner,
          repository.repo_name,
          repository.repo_id,
          repository.base_branch,
          now,
          now
        )
    );
  }

  // --- Environment selection (automation_environments: single source of truth) ---

  async getEnvironmentsForAutomation(automationId: string): Promise<AutomationEnvironmentRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_environments
         WHERE automation_id = ?
         ORDER BY environment_id`
      )
      .bind(automationId)
      .all<AutomationEnvironmentRow>();
    return result.results || [];
  }

  /** Batched variant for the tick loop — one query for all overdue automations. */
  async getEnvironmentsForAutomationIds(
    automationIds: string[]
  ): Promise<Map<string, AutomationEnvironmentRow[]>> {
    const map = new Map<string, AutomationEnvironmentRow[]>();
    for (const id of automationIds) map.set(id, []);
    if (automationIds.length === 0) return map;

    const placeholders = automationIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_environments
         WHERE automation_id IN (${placeholders})
         ORDER BY environment_id`
      )
      .bind(...automationIds)
      .all<AutomationEnvironmentRow>();

    for (const row of result.results ?? []) {
      map.get(row.automation_id)?.push(row);
    }
    return map;
  }

  /** INSERT statements for an automation's environment rows (composable into a batch). */
  bindEnvironmentInserts(
    automationId: string,
    environmentIds: string[],
    now: number
  ): SqlStatement[] {
    return environmentIds.map((environmentId) =>
      this.db
        .prepare(
          `INSERT INTO automation_environments
           (automation_id, environment_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .bind(automationId, environmentId, now, now)
    );
  }

  /** Statements replacing an automation's environment selection. */
  bindReplaceEnvironments(
    automationId: string,
    environmentIds: string[],
    now: number
  ): SqlStatement[] {
    return [
      this.db
        .prepare(`DELETE FROM automation_environments WHERE automation_id = ?`)
        .bind(automationId),
      ...this.bindEnvironmentInserts(automationId, environmentIds, now),
    ];
  }

  /** Statements replacing an automation's repository selection. */
  bindReplaceRepositories(
    automationId: string,
    repositories: AutomationRepositoryInsert[],
    now: number
  ): SqlStatement[] {
    return [
      this.db
        .prepare(`DELETE FROM automation_repositories WHERE automation_id = ?`)
        .bind(automationId),
      ...this.bindRepositoryInserts(automationId, repositories, now),
    ];
  }

  async replaceRepositories(
    automationId: string,
    repositories: AutomationRepositoryInsert[]
  ): Promise<void> {
    await this.db.batch(this.bindReplaceRepositories(automationId, repositories, Date.now()));
  }

  // --- Scheduling queries ---

  async countOverdue(now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM automations
         WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule'
         AND next_run_at IS NOT NULL AND next_run_at <= ?`
      )
      .bind(now)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  async getOverdueAutomations(now: number, limit: number): Promise<AutomationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule'
         AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`
      )
      .bind(now, limit)
      .all<AutomationRow>();
    return (result.results || []).map(withValidatedOwnerTeam);
  }

  // --- Run management ---

  /**
   * Update an active run. SQL-guarded on `status IN ('starting','running')`:
   * a JS pre-check alone is a lost-update race under concurrent callbacks and
   * sweeps — a terminal run must never transition again (a sweep flipping a
   * completed child to failed would retroactively corrupt its invocation's
   * derived status). Returns false when the guard suppressed the write.
   */
  async updateRun(id: string, fields: Partial<AutomationRunRow>): Promise<boolean> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const allowedFields: (keyof AutomationRunRow)[] = [
      "session_id",
      "status",
      "failure_reason",
      "started_at",
      "completed_at",
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (setClauses.length === 0) return false;

    params.push(id);

    const result = await this.db
      .prepare(
        `UPDATE automation_runs SET ${setClauses.join(", ")}
         WHERE id = ? AND status IN ('starting', 'running')`
      )
      .bind(...params)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Atomically assign a session only while a run still awaits launch. The
   * deadline lands in the same statement that makes the run sweepable, so a
   * 'running' row never exists without one. The run's first prompt stays
   * pending until {@link markRunFirstPromptQueued}; continuity follow-ups are
   * held until then.
   */
  async claimRunSession(
    id: string,
    sessionId: string,
    startedAt: number,
    executionDeadlineAt: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'running', session_id = ?, started_at = ?, execution_deadline_at = ?,
             first_prompt_pending = 1
         WHERE id = ? AND status = 'starting'`
      )
      .bind(sessionId, startedAt, executionDeadlineAt, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Record that a run's own first prompt is on its session's queue. From here on
   * {@link holdPromptForLaunchingRun} refuses, so follow-ups go straight to the session.
   */
  async markRunFirstPromptQueued(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE automation_runs SET first_prompt_pending = 0 WHERE id = ?")
      .bind(id)
      .run();
  }

  /**
   * Replace the deadline claimed with the deployment-wide budget once the
   * session's own settings are known. Guarded on 'running' so it cannot revive
   * the sweep's interest in a run that already finished.
   */
  async setRunExecutionDeadline(id: string, executionDeadlineAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_runs SET execution_deadline_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .bind(executionDeadlineAt, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Overturn a sweep-declared timeout with the completion callback that
   * eventually arrived. `execution_timeout` is the only terminal state the
   * scheduler infers rather than observes, so it is the only one a later
   * success may correct — every other terminal state stays final.
   */
  async completeTimedOutRun(id: string, completedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'completed', failure_reason = NULL, completed_at = ?
         WHERE id = ? AND status = 'failed' AND failure_reason = ?`
      )
      .bind(completedAt, id, EXECUTION_TIMEOUT_FAILURE_REASON)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Fail runs the orphan sweep read, if each is still the stuck attempt it read: still
   * `starting` and created before `createdBefore`. A retry relaunched since then restamped
   * created_at, so it is left alone.
   */
  async bulkFailStartingRuns(
    runIds: string[],
    reason: string,
    completedAt: number,
    createdBefore: number
  ): Promise<void> {
    await this.bulkFailRuns(runIds, reason, completedAt, ORPHANED_STARTING_RUN_PREDICATE, [
      createdBefore,
    ]);
  }

  /**
   * Fail runs the deadline sweep read, if each is still past its deadline as of `completedAt`
   * (see {@link getRunsPastExecutionDeadline}); a retry relaunched since then has a new one.
   */
  async bulkFailRunningRuns(
    runIds: string[],
    reason: string,
    completedAt: number,
    defaultDeadlineMs: number
  ): Promise<void> {
    await this.bulkFailRuns(runIds, reason, completedAt, RUN_PAST_EXECUTION_DEADLINE_PREDICATE, [
      completedAt,
      completedAt - defaultDeadlineMs,
    ]);
  }

  private async bulkFailRuns(
    runIds: string[],
    reason: string,
    completedAt: number,
    predicate: string,
    predicateParams: unknown[]
  ): Promise<void> {
    if (runIds.length === 0) return;
    const placeholders = runIds.map(() => "?").join(", ");
    await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'failed', failure_reason = ?, completed_at = ?
         WHERE id IN (${placeholders}) AND ${predicate}`
      )
      .bind(reason, completedAt, ...runIds, ...predicateParams)
      .run();
  }

  // --- Launch retries ---

  /**
   * Record a launch that failed before its prompt was sent. While the automation allows
   * another attempt, the run waits as `retrying` until `retryAt` and keeps holding its
   * automation; otherwise it fails like any launch failure. Guarded like {@link updateRun};
   * null when the guard suppressed both writes.
   */
  async failLaunchOrRetry(
    id: string,
    reason: string,
    failedAt: number,
    retryAt: number
  ): Promise<"retrying" | "failed" | null> {
    const [retry, fail] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE automation_runs
           SET status = 'retrying', failure_reason = ?, retry_at = ?, session_id = NULL,
               started_at = NULL, execution_deadline_at = NULL, first_prompt_pending = 0
           WHERE id = ? AND status IN ('starting', 'running') AND ${RETRY_ALLOWED_SQL}`
        )
        .bind(reason, retryAt, id),
      this.db
        .prepare(
          `UPDATE automation_runs SET status = 'failed', failure_reason = ?, completed_at = ?
           WHERE id = ? AND status IN ('starting', 'running')`
        )
        .bind(reason, failedAt, id),
    ]);
    if ((retry?.meta?.changes ?? 0) > 0) return "retrying";
    return (fail?.meta?.changes ?? 0) > 0 ? "failed" : null;
  }

  /**
   * Waiting runs the retry sweep must settle, soonest first: those due to relaunch, and those
   * their automation no longer allows (paused, deleted, or its limit lowered) so they stop
   * holding it.
   */
  async getRetriesToSettle(now: number, limit: number): Promise<AutomationRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE status = 'retrying' AND (retry_at <= ? OR NOT ${RETRY_ALLOWED_SQL})
         ORDER BY retry_at ASC LIMIT ?`
      )
      .bind(now, limit)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  /**
   * Take a due retry for relaunch. One claim wins across concurrent ticks, none once the
   * automation no longer allows it, none from a copy of `run` read before another tick
   * relaunched it, and none once the team's grants changed from `teamGrantsVersion`, as for a
   * first launch's admission. Restamps created_at so the orphan sweep times this attempt rather
   * than the original firing.
   */
  async claimRetry(
    run: AutomationRunRow,
    now: number,
    teamGrantsVersion?: TeamGrantsVersion
  ): Promise<AutomationRunRow | null> {
    const grantsGuard = teamGrantsGuard(teamGrantsVersion);
    const result = await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'starting', attempt = attempt + 1, retry_at = NULL, failure_reason = NULL,
             created_at = ?
         WHERE id = ? AND status = 'retrying' AND attempt = ? AND retry_at <= ?
           AND ${RETRY_ALLOWED_SQL} ${grantsGuard.sql}`
      )
      .bind(now, run.id, run.attempt ?? 1, now, ...grantsGuard.params)
      .run();
    if ((result.meta?.changes ?? 0) === 0) return null;
    return {
      ...run,
      status: "starting",
      attempt: (run.attempt ?? 1) + 1,
      retry_at: null,
      failure_reason: null,
      created_at: now,
    };
  }

  /** Fail a waiting run its automation no longer allows to relaunch; its last failure stands. */
  async failWithdrawnRetry(id: string, completedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_runs SET status = 'failed', retry_at = NULL, completed_at = ?
         WHERE id = ? AND status = 'retrying' AND NOT ${RETRY_ALLOWED_SQL}`
      )
      .bind(completedAt, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async getActiveRunForAutomation(automationId: string): Promise<AutomationRunRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND status IN ${ACTIVE_RUN_STATUSES_SQL}
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(automationId)
      .first<AutomationRunRow>();
  }

  async getRunById(automationId: string, runId: string): Promise<EnrichedRunRow | null> {
    return this.db
      .prepare(
        `SELECT
           r.*,
           s.title as session_title,
           NULL as artifact_summary
         FROM automation_runs r
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.id = ? AND r.automation_id = ?`
      )
      .bind(runId, automationId)
      .first<EnrichedRunRow>();
  }

  // --- Invocations ---

  /**
   * Per-source overlap predicate, used both as the cheap pre-check and inside
   * the conditional insert (same SQL, one definition). It matches the firings
   * that must be BLOCKED, so the insert reads `WHERE NOT EXISTS (…)`.
   *
   * Schedule/manual firings block once the automation already holds
   * `max_concurrent_runs` invocations in flight, counting one whose run waits to
   * retry (main parity with getActiveRunForAutomation); event firings block per
   * concurrency key only — an automation-wide guard would serialize unrelated
   * events.
   *
   * The schedule/manual arm counts DISTINCT invocations rather than rows. A
   * fan-out automation posts one run per target, so counting rows would refuse
   * a ten-repository automation's second firing at a limit of three while
   * nothing overlapping had happened — the limit is about firings in flight,
   * and the tick's own child-launch budget is what paces their sessions.
   *
   * It also reads the bound from `automations` inside this same statement
   * rather than taking it as a parameter. A firing resolves repositories,
   * authorization and provider auth between reading the automation row and
   * reaching this insert, and a PATCH that lowers the bound during that window
   * would otherwise be overtaken by a firing still comparing against the old
   * value — admitting work past a limit the operator had already lowered.
   * Reading it here lets the database order the two.
   *
   * The inner filter and the COALESCE are the SQL twin of
   * automationConcurrencyLimit: a row carrying zero, a negative, or NULL — and
   * an automation deleted mid-firing — all read as
   * DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS rather than as no bound at all.
   */
  private overlapPredicate(
    automationId: string,
    scope: InvocationOverlapScope
  ): { sql: string; params: unknown[] } {
    if (scope.kind === "concurrencyKey") {
      return {
        sql: `SELECT 1 FROM automation_runs ar
              JOIN automation_invocations ai ON ai.id = ar.invocation_id
              WHERE ar.automation_id = ?
                AND ai.concurrency_key = ?
                AND ar.status IN ${ACTIVE_RUN_STATUSES_SQL}`,
        params: [automationId, scope.concurrencyKey],
      };
    }
    return {
      sql: `SELECT 1 WHERE (
              SELECT COUNT(DISTINCT ar.invocation_id) FROM automation_runs ar
              WHERE ar.automation_id = ? AND ar.status IN ${ACTIVE_RUN_STATUSES_SQL}
            ) >= COALESCE(
              (SELECT a.max_concurrent_runs FROM automations a
               WHERE a.id = ? AND a.max_concurrent_runs >= 1),
              ${DEFAULT_AUTOMATION_MAX_CONCURRENT_RUNS}
            )`,
      params: [automationId, automationId],
    };
  }

  private scheduledInvocationGuard(invocation: AutomationInvocationRow): {
    sql: string;
    params: unknown[];
  } {
    if (invocation.source !== "schedule") return { sql: "", params: [] };
    return {
      sql: `AND EXISTS (SELECT 1 FROM automations a WHERE a.id = ? AND a.deleted_at IS NULL
        AND (a.schedule_once_at IS NULL OR (a.enabled = 1 AND a.next_run_at = ? AND a.schedule_once_at = a.next_run_at)))`,
      params: [invocation.automation_id, invocation.scheduled_at],
    };
  }

  /**
   * Invocations of this automation with at least one active run — the cheap
   * pre-check twin of the schedule/manual overlap predicate above. Counted the
   * same way (DISTINCT invocation_id) so the two cannot disagree about what a
   * firing in flight is.
   */
  async countActiveInvocations(automationId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT ar.invocation_id) AS count FROM automation_runs ar
         WHERE ar.automation_id = ? AND ar.status IN ${ACTIVE_RUN_STATUSES_SQL}`
      )
      .bind(automationId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Atomically create an invocation with its child runs (and optionally
   * advance the schedule) in ONE D1 batch.
   *
   * Every statement is self-guarded because D1's batch() rolls back only on
   * statement ERROR — a 0-row INSERT…SELECT is a success and later statements
   * still run. The invocation insert is suppressed when the overlap predicate
   * matches; child inserts are 0-row no-ops when the invocation was
   * suppressed. A recurring schedule still advances for a blocked firing; a
   * one-shot keeps its slot until the skip is recorded. Advancement is conditioned on owning the
   * slot it claimed. Monotonicity is not enough: two ticks straddling a cron
   * boundary both read slot S, and a "later timestamp wins" predicate lets the
   * loser advance a second time from the winner's successor, skipping a slot
   * outright. Only the transaction that observes S may move it.
   *
   * A UNIQUE violation (cron double-fire on the idempotency index, event dedup
   * on the trigger-key index) rolls back the WHOLE batch including the
   * advance — callers classify via isDuplicateKeyError and recover.
   *
   * Returns inserted=false when the overlap predicate suppressed the firing.
   */
  async insertInvocationGuarded(params: {
    invocation: AutomationInvocationRow;
    children: AutomationRunRow[];
    overlapScope: InvocationOverlapScope;
    advanceSchedule?: ScheduleAdvance;
    /** Team grants version the targets were authorized against; a change refuses admission. */
    teamGrantsVersion?: TeamGrantsVersion;
  }): Promise<{ inserted: boolean }> {
    const invocation = params.invocation;
    const overlap = this.overlapPredicate(invocation.automation_id, params.overlapScope);
    const grantsGuard = teamGrantsGuard(params.teamGrantsVersion);
    const scheduleGuard = this.scheduledInvocationGuard(invocation);
    const statements: SqlStatement[] = [];
    statements.push(
      this.db
        .prepare(
          `INSERT INTO automation_invocations
           (id, automation_id, source, actor_kind, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (${overlap.sql}) ${grantsGuard.sql} ${scheduleGuard.sql}`
        )
        .bind(
          invocation.id,
          invocation.automation_id,
          invocation.source,
          invocation.actor_kind,
          invocation.scheduled_at,
          invocation.trigger_key,
          invocation.concurrency_key,
          invocation.trigger_metadata,
          invocation.skip_reason,
          invocation.failure_counted_at,
          invocation.created_at,
          invocation.updated_at,
          ...overlap.params,
          ...grantsGuard.params,
          ...scheduleGuard.params
        )
    );

    for (const child of params.children) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO automation_runs
             (id, automation_id, invocation_id, session_id, status, skip_reason, failure_reason,
              scheduled_at, started_at, completed_at, created_at,
              repo_owner, repo_name, repo_id, base_branch, environment_id)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM automation_invocations WHERE id = ?)`
          )
          .bind(
            child.id,
            child.automation_id,
            invocation.id,
            child.session_id,
            child.status,
            child.skip_reason,
            child.failure_reason,
            child.scheduled_at,
            child.started_at,
            child.completed_at,
            child.created_at,
            child.repo_owner,
            child.repo_name,
            child.repo_id,
            child.base_branch,
            child.environment_id,
            invocation.id
          )
      );
    }

    if (params.advanceSchedule) {
      statements.push(
        this.bindScheduleAdvance(invocation, params.advanceSchedule, params.teamGrantsVersion)
      );
    }

    const results = await this.db.batch(statements);
    return { inserted: (results[0]?.meta?.changes ?? 0) > 0 };
  }

  /**
   * Consume the claimed slot. Recurring overlap skips may advance before their
   * history is inserted; a one-shot consumes its slot with durable history and
   * stays enabled while its invocation has active runs, allowing launch retries.
   */
  private bindScheduleAdvance(
    invocation: AutomationInvocationRow,
    advance: ScheduleAdvance,
    teamGrantsVersion?: TeamGrantsVersion
  ): SqlStatement {
    const grantsGuard = teamGrantsGuard(teamGrantsVersion);
    return this.db
      .prepare(
        `UPDATE automations SET next_run_at = ?, updated_at = ?,
           enabled = CASE WHEN schedule_once_at IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM automation_runs WHERE invocation_id = ? AND status IN ${ACTIVE_RUN_STATUSES_SQL}
           ) THEN 0 ELSE enabled END
         WHERE id = ? AND deleted_at IS NULL AND next_run_at = ? ${grantsGuard.sql}
           AND (schedule_once_at IS NULL OR EXISTS (SELECT 1 FROM automation_invocations WHERE id = ?))`
      )
      .bind(
        advance.nextRunAt,
        Date.now(),
        invocation.id,
        invocation.automation_id,
        advance.fromSlot,
        ...grantsGuard.params,
        invocation.id
      );
  }

  /** Childless skips and denials use the same live schedule-slot guard. */
  private bindChildlessInvocation(invocation: AutomationInvocationRow): SqlStatement {
    const scheduleGuard = this.scheduledInvocationGuard(invocation);
    return this.db
      .prepare(
        `INSERT INTO automation_invocations
           (id, automation_id, source, actor_kind, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE 1 = 1 ${scheduleGuard.sql}
           ON CONFLICT DO NOTHING`
      )
      .bind(
        invocation.id,
        invocation.automation_id,
        invocation.source,
        invocation.actor_kind,
        invocation.scheduled_at,
        invocation.trigger_key,
        invocation.concurrency_key,
        invocation.trigger_metadata,
        invocation.skip_reason,
        invocation.failure_counted_at,
        invocation.created_at,
        invocation.updated_at,
        ...scheduleGuard.params
      );
  }

  /**
   * Record a skipped firing: a childless invocation carrying skip_reason,
   * atomically paired with the schedule advance when the skip serves a cron
   * slot. The conflict-tolerant insert absorbs an idempotency-index race without
   * blocking the advance — a skip recorded without the advance would
   * re-collide on (automation_id, scheduled_at) every tick thereafter. The
   * advance is a compare-and-set on the claimed slot, so a firing that lost
   * the slot cannot move the schedule a second time.
   */
  async insertSkippedInvocation(
    invocation: AutomationInvocationRow,
    advanceSchedule?: ScheduleAdvance
  ): Promise<{ inserted: boolean }> {
    const statements: SqlStatement[] = [this.bindChildlessInvocation(invocation)];

    if (advanceSchedule) {
      statements.push(this.bindScheduleAdvance(invocation, advanceSchedule));
    }

    const results = await this.db.batch(statements);
    return { inserted: (results[0]?.meta?.changes ?? 0) > 0 };
  }

  /** Atomically record a denied cron slot and pause it so overdue denial cannot starve the queue. */
  async recordAuthorizationDenied(
    invocation: AutomationInvocationRow,
    fromSlot: number
  ): Promise<{ inserted: boolean; paused: boolean }> {
    const results = await this.db.batch([
      this.bindChildlessInvocation(invocation),
      this.db
        .prepare(
          `UPDATE automations
           SET enabled = 0, next_run_at = NULL, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL AND enabled = 1 AND next_run_at = ?
             AND (schedule_once_at IS NULL OR schedule_once_at = next_run_at)`
        )
        .bind(Date.now(), invocation.automation_id, fromSlot),
    ]);
    return {
      inserted: (results[0]?.meta?.changes ?? 0) > 0,
      paused: (results[1]?.meta?.changes ?? 0) > 0,
    };
  }

  async getInvocationById(invocationId: string): Promise<AutomationInvocationRow | null> {
    return this.db
      .prepare(`SELECT * FROM automation_invocations WHERE id = ?`)
      .bind(invocationId)
      .first<AutomationInvocationRow>();
  }

  /** One invocation with its child runs, read from a single consistent snapshot. */
  async getInvocation(
    automationId: string,
    invocationId: string
  ): Promise<AutomationInvocation | null> {
    const [invocationResult, childResult] = await this.db.batch([
      this.db
        .prepare(
          `${ENRICHED_INVOCATION_SELECT_SQL}
           WHERE i.id = ? AND i.automation_id = ?
           GROUP BY i.id`
        )
        .bind(invocationId, automationId),
      this.db
        .prepare(
          `${INVOCATION_CHILD_RUN_SELECT_SQL}
           WHERE r.invocation_id = ?
           ORDER BY r.created_at ASC`
        )
        .bind(invocationId),
    ]);
    const row = invocationResult.results?.[0];
    if (!row) return null;
    const runs = (childResult.results ?? []) as EnrichedRunRow[];
    return toAutomationInvocation(
      enrichedAutomationInvocationRowSchema.parse(row),
      runs.map(toAutomationRun)
    );
  }

  /** The invocation that admitted an event or accepted its webhook follow-up. */
  async getInvocationIdByTriggerKey(
    automationId: string,
    triggerKey: string
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM automation_invocations WHERE automation_id = ? AND trigger_key = ?
         UNION ALL
         SELECT invocation_id AS id FROM automation_follow_up_receipts
         WHERE automation_id = ? AND trigger_key = ? AND accepted_at IS NOT NULL
         LIMIT 1`
      )
      .bind(automationId, triggerKey, automationId, triggerKey)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  /**
   * Count an automation's unskipped firings by `actorKind` created at or after
   * `since`, stopping at `limit`: callers only need to know whether a threshold
   * is reached. The literal `skip_reason IS NULL` lets the count use the partial
   * idx_invocations_actor_created.
   */
  async countFiringsSince(
    automationId: string,
    options: { actorKind: InvocationActorKind; since: number; limit: number }
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT 1 FROM automation_invocations
           WHERE automation_id = ? AND actor_kind = ? AND skip_reason IS NULL
             AND created_at >= ?
           LIMIT ?
         ) AS matching_firings`
      )
      .bind(automationId, options.actorKind, options.since, options.limit)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /** Whether the automation recorded a firing skipped for `skipReason` at or after `since`. */
  async hasSkippedInvocationSince(
    automationId: string,
    skipReason: string,
    since: number
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS found FROM automation_invocations
         WHERE automation_id = ? AND skip_reason = ? AND created_at >= ?
         LIMIT 1`
      )
      .bind(automationId, skipReason, since)
      .first<{ found: number }>();
    return row !== null;
  }

  /** Claim an explicit webhook key before either continuation or invocation work is admitted. */
  async claimFollowUpReceipt(params: {
    automationId: string;
    triggerKey: string;
    claimInvocationId: string;
    claimId: string;
    now: number;
    expiresAt: number;
  }): Promise<FollowUpReceiptClaim> {
    const inserted = await this.db
      .prepare(
        `INSERT INTO automation_follow_up_receipts
           (automation_id, trigger_key, invocation_id, claim_id, claim_invocation_id,
            claim_expires_at, accepted_at, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)
         ON CONFLICT (automation_id, trigger_key) DO NOTHING`
      )
      .bind(
        params.automationId,
        params.triggerKey,
        params.claimId,
        params.claimInvocationId,
        params.expiresAt,
        params.now
      )
      .run();
    if ((inserted.meta?.changes ?? 0) > 0) return { kind: "claimed" };

    const reclaimed = await this.db
      .prepare(
        `UPDATE automation_follow_up_receipts
         SET claim_id = ?, claim_invocation_id = ?, claim_expires_at = ?
         WHERE automation_id = ? AND trigger_key = ?
           AND accepted_at IS NULL AND claim_expires_at <= ?`
      )
      .bind(
        params.claimId,
        params.claimInvocationId,
        params.expiresAt,
        params.automationId,
        params.triggerKey,
        params.now
      )
      .run();
    if ((reclaimed.meta?.changes ?? 0) > 0) return { kind: "claimed" };

    const owner = await this.db
      .prepare(
        `SELECT invocation_id, claim_invocation_id, accepted_at
         FROM automation_follow_up_receipts
         WHERE automation_id = ? AND trigger_key = ?`
      )
      .bind(params.automationId, params.triggerKey)
      .first<{
        invocation_id: string | null;
        claim_invocation_id: string | null;
        accepted_at: number | null;
      }>();
    if (!owner) throw new Error("Failed to read webhook follow-up claim");
    const invocationId = owner.invocation_id ?? owner.claim_invocation_id;
    if (!invocationId) throw new Error("Webhook follow-up claim has no invocation owner");
    return {
      kind: owner.accepted_at === null ? "pending" : "accepted",
      invocationId,
    };
  }

  async acceptFollowUpReceipt(
    automationId: string,
    triggerKey: string,
    claimId: string,
    invocationId: string,
    acceptedAt: number
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE automation_follow_up_receipts
         SET invocation_id = ?, claim_id = NULL, claim_invocation_id = NULL,
             claim_expires_at = NULL, accepted_at = ?
         WHERE automation_id = ? AND trigger_key = ? AND claim_id = ? AND accepted_at IS NULL`
      )
      .bind(invocationId, acceptedAt, automationId, triggerKey, claimId)
      .run();
    if ((result.meta?.changes ?? 0) === 0)
      throw new Error("Failed to accept webhook follow-up receipt claim");
  }

  async releaseFollowUpReceipt(
    automationId: string,
    triggerKey: string,
    claimId: string
  ): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM automation_follow_up_receipts
         WHERE automation_id = ? AND trigger_key = ? AND claim_id = ? AND accepted_at IS NULL`
      )
      .bind(automationId, triggerKey, claimId)
      .run();
  }

  /** Sibling-run aggregate for finalization decisions (one query, no stored status). */
  async getInvocationRunAggregate(invocationId: string): Promise<InvocationRunAggregate> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status IN ${ACTIVE_RUN_STATUSES_SQL} THEN 1 ELSE 0 END), 0) AS active,
           COALESCE(SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END), 0) AS retrying,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
           MAX(completed_at) AS last_completed_at
         FROM automation_runs WHERE invocation_id = ?`
      )
      .bind(invocationId)
      .first<{
        total: number;
        active: number;
        retrying: number;
        failed: number;
        completed: number;
        skipped: number;
        last_completed_at: number | null;
      }>();

    return {
      total: row?.total ?? 0,
      active: row?.active ?? 0,
      retrying: row?.retrying ?? 0,
      failed: row?.failed ?? 0,
      completed: row?.completed ?? 0,
      skipped: row?.skipped ?? 0,
      lastCompletedAt: row?.last_completed_at ?? null,
    };
  }

  /**
   * CAS for auto-pause accounting: exactly one caller wins the right to count
   * this invocation's failure, no matter how many callbacks race.
   */
  async tryMarkInvocationFailureCounted(invocationId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        `UPDATE automation_invocations SET failure_counted_at = ?, updated_at = ?
         WHERE id = ? AND failure_counted_at IS NULL`
      )
      .bind(now, now, invocationId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async listInvocations(
    automationId: string,
    options: { limit: number; offset: number }
  ): Promise<{ invocations: AutomationInvocation[]; total: number }> {
    const [countResult, pageResult] = await this.db.batch([
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM automation_invocations WHERE automation_id = ?`)
        .bind(automationId),
      this.db
        .prepare(
          `${ENRICHED_INVOCATION_SELECT_SQL}
           WHERE i.automation_id = ?
           GROUP BY i.id
           ORDER BY i.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(automationId, options.limit, options.offset),
    ]);

    const total = countRowSchema.parse(countResult.results?.[0]).count;
    // A malformed stored row is an integrity error, not a missing invocation.
    // Reject the page instead of silently returning incomplete history.
    const rows = enrichedAutomationInvocationRowSchema.array().parse(pageResult.results ?? []);
    if (rows.length === 0) return { invocations: [], total };

    const placeholders = rows.map(() => "?").join(", ");
    const childResult = await this.db
      .prepare(
        `${INVOCATION_CHILD_RUN_SELECT_SQL}
         WHERE r.invocation_id IN (${placeholders})
         ORDER BY r.created_at ASC`
      )
      .bind(...rows.map((row) => row.id))
      .all<EnrichedRunRow>();

    const childrenByInvocation = new Map<string, AutomationRun[]>();
    for (const child of childResult.results ?? []) {
      const invocationId = child.invocation_id;
      const bucket = childrenByInvocation.get(invocationId) ?? [];
      bucket.push(toAutomationRun(child));
      childrenByInvocation.set(invocationId, bucket);
    }

    return {
      invocations: rows.map((row) =>
        toAutomationInvocation(row, childrenByInvocation.get(row.id) ?? [])
      ),
      total,
    };
  }

  // --- Invocation finalization sweep (D2c) ---

  /**
   * Recent all-terminal invocations with a failed child whose failure was
   * never counted — the crash-after-last-callback window. Bounded by
   * created_at (idx_invocations_created) to keep the derived-status scan cheap.
   */
  async getUncountedFailedInvocations(
    sinceMs: number,
    limit: number
  ): Promise<AutomationInvocationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT i.* FROM automation_invocations i
         WHERE i.created_at >= ?
           AND i.skip_reason IS NULL
           AND i.failure_counted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM automation_runs r
             WHERE r.invocation_id = i.id AND r.status = 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM automation_runs r
             WHERE r.invocation_id = i.id AND r.status IN ${ACTIVE_RUN_STATUSES_SQL})
         ORDER BY i.created_at ASC
         LIMIT ?`
      )
      .bind(sinceMs, limit)
      .all<AutomationInvocationRow>();
    return result.results || [];
  }

  /**
   * Automations still carrying consecutive_failures whose LATEST recent
   * accounting-relevant invocation may be a fully-completed one (missed reset). The
   * caller verifies completeness via the sibling aggregate before resetting —
   * a newer failed invocation naturally disqualifies its automation here.
   */
  async getStaleFailureResetCandidates(
    sinceMs: number,
    limit: number
  ): Promise<Array<{ automation_id: string; invocation_id: string }>> {
    const result = await this.db
      .prepare(
        `SELECT a.id AS automation_id,
                (SELECT i.id FROM automation_invocations i
                 WHERE i.automation_id = a.id AND i.skip_reason IS NULL AND i.created_at >= ?
                   AND EXISTS (
                     SELECT 1 FROM automation_runs r
                     WHERE r.invocation_id = i.id
                       AND r.status IN ('starting', 'running', 'retrying', 'completed', 'failed'))
                 ORDER BY i.created_at DESC LIMIT 1) AS invocation_id
         FROM automations a
         WHERE a.consecutive_failures > 0 AND a.deleted_at IS NULL
         LIMIT ?`
      )
      .bind(sinceMs, limit)
      .all<{ automation_id: string; invocation_id: string | null }>();

    return (result.results || []).filter(
      (row): row is { automation_id: string; invocation_id: string } => row.invocation_id !== null
    );
  }

  // --- Event matching queries ---

  async getAutomationsForEvent(
    repoOwner: string,
    repoName: string,
    triggerType: string,
    eventType: string
  ): Promise<AutomationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT a.* FROM automations a
         JOIN automation_repositories ar ON ar.automation_id = a.id
         WHERE ar.repo_owner = ? AND ar.repo_name = ?
           AND a.trigger_type = ? AND a.event_type = ?
           AND a.enabled = 1 AND a.deleted_at IS NULL`
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase(), triggerType, eventType)
      .all<AutomationRow>();
    return (result.results || []).map(withValidatedOwnerTeam);
  }

  async getActiveRunForKey(
    automationId: string,
    concurrencyKey: string | null
  ): Promise<AutomationRunRow | null> {
    if (concurrencyKey === null) {
      return this.getActiveRunForAutomation(automationId);
    }
    return this.db
      .prepare(
        `SELECT r.* FROM automation_runs r
         JOIN automation_invocations i ON i.id = r.invocation_id
         WHERE r.automation_id = ?
           AND i.concurrency_key = ?
           AND r.status IN ${ACTIVE_RUN_STATUSES_SQL}
         ORDER BY r.created_at DESC LIMIT 1`
      )
      .bind(automationId, concurrencyKey)
      .first<AutomationRunRow>();
  }

  /**
   * The most recent run for a concurrency key that has a session (any status)
   * or is still launching. A session id the run claimed but never created (a
   * launch that failed early) does not count. Powers session continuity: a Slack thread reply or a
   * webhook delivery with the same `sessionKey` continues this run's session
   * regardless of run status. Excludes skipped rows and runs that never got a
   * session. `last_activity_at` is the session's latest activity, falling back
   * to the run's creation; the continuity window is measured from it. Served by
   * idx_invocations_concurrency joined to idx_runs_invocation (keys live on the
   * invocation).
   */
  async getLatestContinuableRun(
    automationId: string,
    concurrencyKey: string | null
  ): Promise<ContinuableRunRow | null> {
    if (concurrencyKey === null) return null;
    return this.db
      .prepare(
        `SELECT r.*, COALESCE(s.updated_at, r.created_at) AS last_activity_at,
           EXISTS (
             SELECT 1 FROM automation_run_held_prompts h WHERE h.run_id = r.id
           ) AS has_held_prompts
         FROM automation_runs r
         JOIN automation_invocations i ON i.id = r.invocation_id
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.automation_id = ?
           AND i.concurrency_key = ?
           AND (
             s.id IS NOT NULL
             OR r.status = 'starting'
             OR (r.status = 'running' AND r.first_prompt_pending = 1)
           )
         ORDER BY r.created_at DESC LIMIT 1`
      )
      .bind(automationId, concurrencyKey)
      .first<ContinuableRunRow>();
  }

  /** Every session previously used by a continuity key, newest first. */
  async getSessionRunsForContinuityKey(
    automationId: string,
    concurrencyKey: string | null
  ): Promise<Array<{ invocation_id: string; session_id: string }>> {
    if (concurrencyKey === null) return [];
    const result = await this.db
      .prepare(
        `SELECT r.invocation_id, r.session_id FROM automation_runs r
         JOIN automation_invocations i ON i.id = r.invocation_id
         WHERE r.automation_id = ? AND i.concurrency_key = ? AND r.session_id IS NOT NULL
         ORDER BY r.created_at DESC`
      )
      .bind(automationId, concurrencyKey)
      .all<{ invocation_id: string; session_id: string }>();
    return result.results || [];
  }

  // --- Held continuity prompts ---

  /**
   * Hold a follow-up for a run whose own first prompt is not queued yet, or whose
   * earlier held follow-ups are not all released, so it queues behind them. The
   * insert is conditional on that state, so it either lands before the release
   * drains the run's last held prompt (and is released with them) or does nothing.
   * A follow-up with a clientRequestId already held for the run is a duplicate.
   */
  async holdPromptForLaunchingRun(prompt: HeldPromptRow): Promise<HoldPromptResult> {
    const result = await this.db
      .prepare(
        `INSERT INTO automation_run_held_prompts
           (id, run_id, actor_user_id, actor_author_id, client_request_id, prompt, request_id,
            created_at, retry_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automation_runs
           WHERE id = ?
             AND (status = 'starting' OR (status = 'running' AND first_prompt_pending = 1))
         ) OR EXISTS (SELECT 1 FROM automation_run_held_prompts WHERE run_id = ?)
         ON CONFLICT (run_id, client_request_id) DO NOTHING`
      )
      .bind(
        prompt.id,
        prompt.run_id,
        prompt.actor_user_id,
        prompt.actor_author_id,
        prompt.client_request_id,
        prompt.prompt,
        prompt.request_id,
        prompt.created_at,
        prompt.retry_at,
        prompt.run_id,
        prompt.run_id
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) return "held";

    const existing = await this.db
      .prepare(
        "SELECT 1 AS held FROM automation_run_held_prompts WHERE run_id = ? AND client_request_id = ?"
      )
      .bind(prompt.run_id, prompt.client_request_id)
      .first<{ held: number }>();
    return existing ? "duplicate" : "not_holding";
  }

  async getHeldPrompts(runId: string): Promise<HeldPromptRow[]> {
    const result = await this.db
      .prepare("SELECT * FROM automation_run_held_prompts WHERE run_id = ? ORDER BY created_at, id")
      .bind(runId)
      .all<HeldPromptRow>();
    return result.results || [];
  }

  async deleteHeldPrompt(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM automation_run_held_prompts WHERE id = ?").bind(id).run();
  }

  async deleteHeldPromptsForRun(runId: string): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM automation_run_held_prompts WHERE run_id = ?")
      .bind(runId)
      .run();
    return result.meta?.changes ?? 0;
  }

  /** Runs whose held prompts the sweep should try to settle by `now`, longest-waiting first. */
  async getRunsWithDueHeldPrompts(now: number, limit: number): Promise<AutomationRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT r.* FROM automation_runs r
         JOIN (
           SELECT run_id, MIN(retry_at) AS due_at FROM automation_run_held_prompts
           GROUP BY run_id HAVING MIN(retry_at) <= ?
           ORDER BY due_at LIMIT ?
         ) due ON due.run_id = r.id
         ORDER BY due.due_at`
      )
      .bind(now, limit)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  /** Push back the sweep's next attempt at a run it could not settle. */
  async deferHeldPrompts(runId: string, retryAt: number): Promise<void> {
    await this.db
      .prepare("UPDATE automation_run_held_prompts SET retry_at = ? WHERE run_id = ?")
      .bind(retryAt, runId)
      .run();
  }

  // --- Recovery sweep queries ---
  // Backed by partial indexes (migrations 0024 and 0079); `status` must stay a
  // literal, not a bound param, or the planner skips the index and full-scans
  // automation_runs.
  static readonly ORPHANED_STARTING_RUNS_SQL = `SELECT * FROM automation_runs WHERE ${ORPHANED_STARTING_RUN_PREDICATE}`;
  // A 'running' row without a deadline predates migration 0079, or was claimed
  // by a worker that does (the migration applies before that worker is
  // replaced). Those rows are held to the deployment-default deadline measured
  // from started_at; leaving them out would let one lost callback keep the run
  // 'running', and its automation blocked, forever.
  static readonly RUNS_PAST_EXECUTION_DEADLINE_SQL = `SELECT * FROM automation_runs WHERE ${RUN_PAST_EXECUTION_DEADLINE_PREDICATE}`;

  async getOrphanedStartingRuns(thresholdMs: number, limit: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db
      .prepare(`${AutomationStore.ORPHANED_STARTING_RUNS_SQL} ORDER BY created_at ASC LIMIT ?`)
      .bind(cutoff, limit)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  /**
   * Runs whose session should have reported in by now. The deadline is the
   * run's own, stamped at launch, so this asks "has this run's budget been
   * spent?" rather than "has it been running a long time?". A run with no
   * deadline of its own is due `defaultDeadlineMs` after it started.
   */
  async getRunsPastExecutionDeadline(
    now: number,
    defaultDeadlineMs: number,
    limit: number
  ): Promise<AutomationRunRow[]> {
    const result = await this.db
      .prepare(
        `${AutomationStore.RUNS_PAST_EXECUTION_DEADLINE_SQL}
         ORDER BY COALESCE(execution_deadline_at, started_at) ASC LIMIT ?`
      )
      .bind(now, now - defaultDeadlineMs, limit)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  // --- Failure tracking ---

  async incrementConsecutiveFailures(automationId: string): Promise<number> {
    await this.db
      .prepare(
        "UPDATE automations SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(Date.now(), automationId)
      .run();

    const row = await this.db
      .prepare("SELECT consecutive_failures FROM automations WHERE id = ? AND deleted_at IS NULL")
      .bind(automationId)
      .first<{ consecutive_failures: number }>();

    return row?.consecutive_failures ?? 0;
  }

  async resetConsecutiveFailures(automationId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE automations SET consecutive_failures = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(Date.now(), automationId)
      .run();
  }

  async autoPause(automationId: string): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        "UPDATE automations SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(now, automationId)
      .run();
  }
}

/**
 * True when a D1 write failed on one of the invocation dedup indexes:
 * idx_invocations_trigger_key (event dedup) or idx_invocations_idempotency
 * (cron double-fire on automation_id + scheduled_at). Matching column/table
 * substrings (not D1's full `table.col, table.col` string) stays robust to
 * exact message formatting, while unrelated UNIQUE violations keep surfacing
 * as real errors instead of being swallowed as duplicates.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("UNIQUE constraint failed")) return false;
  return message.includes("trigger_key") || message.includes("automation_invocations");
}
