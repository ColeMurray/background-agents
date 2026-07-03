/**
 * AutomationStore — D1 persistence for automations and automation runs.
 *
 * Follows the same pattern as SessionIndexStore: constructor takes D1Database,
 * snake_case rows in the database, camelCase types at the API boundary.
 */

import type {
  Automation,
  AutomationInvocation,
  AutomationInvocationSource,
  AutomationInvocationStatus,
  AutomationRepository,
  AutomationRun,
  AutomationRunStatus,
  TriggerConfig,
} from "@open-inspect/shared";

// ─── Internal row types ──────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  name: string;
  repo_owner: string | null;
  repo_name: string | null;
  base_branch: string | null;
  repo_id: number | null;
  instructions: string;
  trigger_type: string;
  schedule_cron: string | null;
  schedule_tz: string;
  model: string;
  reasoning_effort: string | null;
  enabled: number; // SQLite integer boolean
  next_run_at: number | null;
  consecutive_failures: number;
  created_by: string;
  user_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  event_type: string | null;
  trigger_config: string | null; // JSON-serialized TriggerConfig
  trigger_auth_data: string | null;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  /** Owning invocation. Nullable in DDL only; every row has one post-backfill. */
  invocation_id: string | null;
  session_id: string | null;
  status: AutomationRunStatus;
  skip_reason: string | null;
  failure_reason: string | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  /** Frozen legacy column — firing keys live on the invocation; NULL on new rows. */
  trigger_key: string | null;
  /** Frozen legacy column — see trigger_key. */
  concurrency_key: string | null;
  /** Repository snapshot taken at firing time (null for repo-less runs). */
  repo_owner: string | null;
  repo_name: string | null;
  repo_id: number | null;
  base_branch: string | null;
  // Source-specific run metadata as JSON. Frozen legacy column — firing
  // metadata lives on the invocation; NULL on new rows.
  trigger_run_metadata?: string | null;
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
export type NewAutomationRepository = Pick<
  AutomationRepositoryRow,
  "repo_owner" | "repo_name" | "repo_id" | "base_branch"
>;

/**
 * Scalar mirror values for the transitional dual-write: a single repository is
 * mirrored onto automations.repo_*, anything else clears them. Keeps rolled-
 * back code (which reads only the scalars) correct for 0/1-repository
 * automations.
 */
export function repositoryScalarMirror(
  repositories: NewAutomationRepository[]
): Pick<AutomationRow, "repo_owner" | "repo_name" | "repo_id" | "base_branch"> {
  if (repositories.length === 1) {
    const [repository] = repositories;
    return {
      repo_owner: repository.repo_owner,
      repo_name: repository.repo_name,
      repo_id: repository.repo_id,
      base_branch: repository.base_branch,
    };
  }
  return { repo_owner: null, repo_name: null, repo_id: null, base_branch: null };
}

export interface AutomationInvocationRow {
  id: string;
  automation_id: string;
  source: AutomationInvocationSource;
  scheduled_at: number | null;
  trigger_key: string | null;
  concurrency_key: string | null;
  trigger_metadata: string | null;
  skip_reason: string | null;
  failure_counted_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Overlap scope for a new invocation: schedule/manual firings block on any
 * active run of the automation; event firings block per concurrency key.
 */
export type InvocationOverlapScope =
  | { kind: "automation" }
  | { kind: "concurrencyKey"; concurrencyKey: string };

/** Sibling-run aggregate for one invocation (finalization input). */
export interface InvocationRunAggregate {
  total: number;
  active: number;
  failed: number;
  completed: number;
  skipped: number;
  lastCompletedAt: number | null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function toAutomationRepository(row: AutomationRepositoryRow): AutomationRepository {
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoId: row.repo_id,
    baseBranch: row.base_branch,
  };
}

/**
 * Map an automation row plus its repository rows to the response shape.
 *
 * With no repository rows (omitted, or genuinely absent) the list is
 * synthesized from the scalar mirror. That keeps automations written by
 * rolled-back pre-invocations code (scalars only, no rows) rendering
 * correctly until the 0030 backfill repairs them; for anything written by
 * current code, empty rows imply cleared scalars, so the fallback yields the
 * same empty list. Removed with the scalar mirrors.
 */
export function toAutomation(
  row: AutomationRow,
  repositoryRows?: AutomationRepositoryRow[]
): Automation {
  const triggerConfig: TriggerConfig | null = row.trigger_config
    ? JSON.parse(row.trigger_config)
    : null;

  let repositories: AutomationRepository[];
  if (repositoryRows && repositoryRows.length > 0) {
    repositories = repositoryRows.map(toAutomationRepository);
  } else {
    if ((row.repo_owner === null) !== (row.repo_name === null)) {
      throw new Error(
        "Automation repository context must include repo_owner and repo_name together"
      );
    }
    repositories =
      row.repo_owner !== null && row.repo_name !== null
        ? [
            {
              repoOwner: row.repo_owner,
              repoName: row.repo_name,
              repoId: row.repo_id,
              baseBranch: row.base_branch,
            },
          ]
        : [];
  }

  // Deprecated scalar mirrors: repositories[0] when exactly one repository,
  // else null — keeps stale web bundles rendering and stops their edit forms
  // from null-clearing the selection.
  const mirror = repositories.length === 1 ? repositories[0] : null;

  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    triggerType: row.trigger_type as Automation["triggerType"],
    scheduleCron: row.schedule_cron,
    scheduleTz: row.schedule_tz,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    consecutiveFailures: row.consecutive_failures,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    eventType: row.event_type ?? null,
    triggerConfig,
    repositories,
    repoOwner: mirror?.repoOwner ?? null,
    repoName: mirror?.repoName ?? null,
    baseBranch: mirror?.baseBranch ?? null,
    repoId: mirror?.repoId ?? null,
  };
}

function assertAutomationRepositoryFields(row: Partial<AutomationRow>): void {
  const repoOwner = row.repo_owner ?? null;
  const repoName = row.repo_name ?? null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Automation repository must include repo_owner and repo_name together");
  }

  if (repoOwner === null && (row.base_branch != null || row.repo_id != null)) {
    throw new Error("Automation base_branch and repo_id require repository context");
  }
}

export function toAutomationRun(row: EnrichedRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    invocationId: row.invocation_id ?? null,
    sessionId: row.session_id,
    status: row.status,
    skipReason: row.skip_reason,
    failureReason: row.failure_reason,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    sessionTitle: row.session_title,
    artifactSummary: row.artifact_summary,
    triggerKey: row.trigger_key ?? null,
    concurrencyKey: row.concurrency_key ?? null,
    repoOwner: row.repo_owner ?? null,
    repoName: row.repo_name ?? null,
    repoId: row.repo_id ?? null,
    baseBranch: row.base_branch ?? null,
  };
}

// ─── Derived invocation status ───────────────────────────────────────────────
// Single SQL definition (aggregated over an invocation's child runs, aliased
// `r`) with a TS twin below — integration tests assert the two agree. Arms, in
// order: childless ⇒ skipped (new skips are childless; the app enforces
// skip_reason on them); any active child ⇒ starting until any child has left
// 'starting', then running; all-terminal: all skipped ⇒ skipped (legacy
// backfilled skip rows), no failure ⇒ completed, no success ⇒ failed,
// otherwise partial_failed.

export const DERIVED_INVOCATION_STATUS_SQL = `CASE
  WHEN COUNT(r.id) = 0 THEN 'skipped'
  WHEN SUM(CASE WHEN r.status IN ('starting', 'running') THEN 1 ELSE 0 END) > 0 THEN
    CASE
      WHEN SUM(CASE WHEN r.status <> 'starting' THEN 1 ELSE 0 END) = 0 THEN 'starting'
      ELSE 'running'
    END
  WHEN SUM(CASE WHEN r.status = 'skipped' THEN 1 ELSE 0 END) = COUNT(r.id) THEN 'skipped'
  WHEN SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) = 0 THEN 'completed'
  WHEN SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) = 0 THEN 'failed'
  ELSE 'partial_failed'
END`;

/** Derived completion time: latest child completion once all children are terminal. */
export const DERIVED_INVOCATION_COMPLETED_AT_SQL = `CASE
  WHEN COUNT(r.id) = 0 THEN NULL
  WHEN SUM(CASE WHEN r.status IN ('starting', 'running') THEN 1 ELSE 0 END) > 0 THEN NULL
  ELSE MAX(r.completed_at)
END`;

/**
 * TS twin of DERIVED_INVOCATION_STATUS_SQL over a sibling aggregate. Keep the
 * two in lockstep.
 */
export function deriveInvocationStatus(counts: {
  total: number;
  active: number;
  failed: number;
  completed: number;
  skipped: number;
  starting?: number;
}): AutomationInvocationStatus {
  if (counts.total === 0) return "skipped";
  if (counts.active > 0) {
    return counts.starting === counts.total ? "starting" : "running";
  }
  if (counts.skipped === counts.total) return "skipped";
  if (counts.failed === 0) return "completed";
  if (counts.completed === 0) return "failed";
  return "partial_failed";
}

export function toAutomationInvocation(
  row: AutomationInvocationRow & { derived_status: string; derived_completed_at: number | null },
  runs: AutomationRun[]
): AutomationInvocation {
  const skipped = row.skip_reason !== null;
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.derived_status as AutomationInvocationStatus,
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

export class AutomationStore {
  constructor(private readonly db: D1Database) {}

  // --- Automation CRUD ---

  /**
   * Prepared INSERT for an automation row. Public so a route can compose it with
   * `SlackChannelStore.bindChannelStatements` into one atomic `db.batch`.
   */
  bindAutomationInsert(row: AutomationRow): D1PreparedStatement {
    assertAutomationRepositoryFields(row);

    return this.db
      .prepare(
        `INSERT INTO automations
         (id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
          trigger_type, schedule_cron, schedule_tz, model, reasoning_effort, enabled, next_run_at,
          consecutive_failures, created_by, user_id, created_at, updated_at, deleted_at,
          event_type, trigger_config, trigger_auth_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.name,
        row.repo_owner,
        row.repo_name,
        row.base_branch,
        row.repo_id,
        row.instructions,
        row.trigger_type,
        row.schedule_cron,
        row.schedule_tz,
        row.model,
        row.reasoning_effort,
        row.enabled,
        row.next_run_at,
        row.consecutive_failures,
        row.created_by,
        row.user_id,
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.event_type,
        row.trigger_config,
        row.trigger_auth_data
      );
  }

  async create(row: AutomationRow): Promise<void> {
    await this.bindAutomationInsert(row).run();
  }

  async getById(id: string): Promise<AutomationRow | null> {
    return this.db
      .prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL")
      .bind(id)
      .first<AutomationRow>();
  }

  async list(
    options: { repoOwner?: string; repoName?: string } = {}
  ): Promise<{ automations: AutomationRow[]; total: number }> {
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];

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

    const where = `WHERE ${conditions.join(" AND ")}`;

    const result = await this.db
      .prepare(`SELECT * FROM automations ${where} ORDER BY created_at DESC`)
      .bind(...params)
      .all<AutomationRow>();

    const automations = result.results || [];
    return { automations, total: automations.length };
  }

  /**
   * Build the dynamic UPDATE statement for the allowed automation fields, or
   * null when `fields` carries nothing to write. Public so a route can compose it
   * with `SlackChannelStore.bindChannelStatements` into one atomic `db.batch`.
   */
  bindAutomationUpdate(id: string, fields: Partial<AutomationRow>): D1PreparedStatement | null {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    // Repository fields are deliberately absent: the selection lives in
    // automation_repositories, and the scalar mirror is written only by
    // bindReplaceRepositories (the single dual-write site).
    const allowedFields: (keyof AutomationRow)[] = [
      "name",
      "instructions",
      "schedule_cron",
      "schedule_tz",
      "model",
      "reasoning_effort",
      "next_run_at",
      "enabled",
      "consecutive_failures",
      "event_type",
      "trigger_config",
      "trigger_auth_data",
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
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

  async softDelete(id: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        "UPDATE automations SET deleted_at = ?, next_run_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(now, now, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async pause(id: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        "UPDATE automations SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(now, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async resume(id: string, nextRunAt: number | null): Promise<boolean> {
    const now = Date.now();
    const result = await this.db
      .prepare(
        "UPDATE automations SET enabled = 1, next_run_at = ?, consecutive_failures = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(nextRunAt, now, id)
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
    repositories: NewAutomationRepository[],
    now: number
  ): D1PreparedStatement[] {
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

  /**
   * Statements replacing an automation's repository selection, including the
   * transitional dual-write of the scalar mirror columns on `automations` —
   * the ONE write site that still touches automations.repo_* (rollback cover
   * for 0/1-repository automations; removed when the columns are dropped).
   */
  bindReplaceRepositories(
    automationId: string,
    repositories: NewAutomationRepository[],
    now: number
  ): D1PreparedStatement[] {
    const mirror = repositoryScalarMirror(repositories);
    return [
      this.db
        .prepare(`DELETE FROM automation_repositories WHERE automation_id = ?`)
        .bind(automationId),
      ...this.bindRepositoryInserts(automationId, repositories, now),
      this.db
        .prepare(
          `UPDATE automations SET repo_owner = ?, repo_name = ?, repo_id = ?, base_branch = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        )
        .bind(
          mirror.repo_owner,
          mirror.repo_name,
          mirror.repo_id,
          mirror.base_branch,
          now,
          automationId
        ),
    ];
  }

  async replaceRepositories(
    automationId: string,
    repositories: NewAutomationRepository[]
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
    return result.results || [];
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

  /** Fail stuck runs. Same SQL guard as updateRun — sweeps must never flip terminal rows. */
  async bulkFailRuns(runIds: string[], reason: string, completedAt: number): Promise<void> {
    if (runIds.length === 0) return;
    const placeholders = runIds.map(() => "?").join(", ");
    await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'failed', failure_reason = ?, completed_at = ?
         WHERE id IN (${placeholders}) AND status IN ('starting', 'running')`
      )
      .bind(reason, completedAt, ...runIds)
      .run();
  }

  async bulkIncrementFailures(
    automationIdCounts: Map<string, number>
  ): Promise<Map<string, number>> {
    if (automationIdCounts.size === 0) return new Map();

    const now = Date.now();
    const automationIds = [...automationIdCounts.keys()];

    const statements = automationIds.map((automationId) =>
      this.db
        .prepare(
          `UPDATE automations
           SET consecutive_failures = consecutive_failures + ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        )
        .bind(automationIdCounts.get(automationId)!, now, automationId)
    );
    await this.db.batch(statements);

    const placeholders = automationIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT id, consecutive_failures FROM automations
         WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      )
      .bind(...automationIds)
      .all<{ id: string; consecutive_failures: number }>();

    const counts = new Map<string, number>();
    for (const row of result.results ?? []) {
      counts.set(row.id, row.consecutive_failures);
    }
    return counts;
  }

  async getActiveRunForAutomation(automationId: string): Promise<AutomationRunRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND status IN ('starting', 'running')
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
   * the guarded insert (same SQL, one definition). Schedule/manual firings
   * block on ANY active run of the automation (main parity with
   * getActiveRunForAutomation); event firings block per concurrency key only —
   * an automation-wide guard would serialize unrelated events.
   */
  private overlapPredicate(
    automationId: string,
    scope: InvocationOverlapScope
  ): { sql: string; params: unknown[] } {
    if (scope.kind === "concurrencyKey") {
      // COALESCE covers rows whose key still lives on the run: legacy history
      // (backfilled invocations also carry it) and anything written by
      // rolled-back code during a soak window. Simplified away when the frozen
      // run columns are dropped.
      return {
        sql: `SELECT 1 FROM automation_runs ar
              LEFT JOIN automation_invocations ai ON ai.id = ar.invocation_id
              WHERE ar.automation_id = ?
                AND COALESCE(ai.concurrency_key, ar.concurrency_key) = ?
                AND ar.status IN ('starting', 'running')`,
        params: [automationId, scope.concurrencyKey],
      };
    }
    return {
      sql: `SELECT 1 FROM automation_runs ar
            WHERE ar.automation_id = ? AND ar.status IN ('starting', 'running')`,
      params: [automationId],
    };
  }

  /**
   * Atomically create an invocation with its child runs (and optionally
   * advance the schedule) in ONE D1 batch.
   *
   * Every statement is self-guarded because D1's batch() rolls back only on
   * statement ERROR — a 0-row INSERT…SELECT is a success and later statements
   * still run. The invocation insert is suppressed when the overlap predicate
   * matches; child inserts are 0-row no-ops when the invocation was
   * suppressed; the schedule advance is deliberately unconditional (a blocked
   * firing must still advance or the tick re-collides forever).
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
    advanceSchedule?: { nextRunAt: number };
  }): Promise<{ inserted: boolean }> {
    const invocation = params.invocation;
    const overlap = this.overlapPredicate(invocation.automation_id, params.overlapScope);
    const statements: D1PreparedStatement[] = [];

    statements.push(
      this.db
        .prepare(
          `INSERT INTO automation_invocations
           (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (${overlap.sql})`
        )
        .bind(
          invocation.id,
          invocation.automation_id,
          invocation.source,
          invocation.scheduled_at,
          invocation.trigger_key,
          invocation.concurrency_key,
          invocation.trigger_metadata,
          invocation.skip_reason,
          invocation.failure_counted_at,
          invocation.created_at,
          invocation.updated_at,
          ...overlap.params
        )
    );

    for (const child of params.children) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO automation_runs
             (id, automation_id, invocation_id, session_id, status, skip_reason, failure_reason,
              scheduled_at, started_at, completed_at, created_at,
              repo_owner, repo_name, repo_id, base_branch)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
            invocation.id
          )
      );
    }

    if (params.advanceSchedule) {
      statements.push(
        this.db
          .prepare(
            `UPDATE automations SET next_run_at = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`
          )
          .bind(params.advanceSchedule.nextRunAt, Date.now(), invocation.automation_id)
      );
    }

    const results = await this.db.batch(statements);
    return { inserted: (results[0]?.meta?.changes ?? 0) > 0 };
  }

  /**
   * Record a skipped firing: a childless invocation carrying skip_reason,
   * atomically paired with the schedule advance when the skip serves a cron
   * slot. INSERT OR IGNORE tolerates an idempotency-index race without
   * blocking the advance — a skip recorded without the advance would
   * re-collide on (automation_id, scheduled_at) every tick thereafter.
   */
  async insertSkippedInvocation(
    invocation: AutomationInvocationRow,
    advanceSchedule?: { nextRunAt: number }
  ): Promise<{ inserted: boolean }> {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT OR IGNORE INTO automation_invocations
           (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
            trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          invocation.id,
          invocation.automation_id,
          invocation.source,
          invocation.scheduled_at,
          invocation.trigger_key,
          invocation.concurrency_key,
          invocation.trigger_metadata,
          invocation.skip_reason,
          invocation.failure_counted_at,
          invocation.created_at,
          invocation.updated_at
        ),
    ];

    if (advanceSchedule) {
      statements.push(
        this.db
          .prepare(
            `UPDATE automations SET next_run_at = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`
          )
          .bind(advanceSchedule.nextRunAt, Date.now(), invocation.automation_id)
      );
    }

    const results = await this.db.batch(statements);
    return { inserted: (results[0]?.meta?.changes ?? 0) > 0 };
  }

  async getInvocationById(invocationId: string): Promise<AutomationInvocationRow | null> {
    return this.db
      .prepare(`SELECT * FROM automation_invocations WHERE id = ?`)
      .bind(invocationId)
      .first<AutomationInvocationRow>();
  }

  /** Sibling-run aggregate for finalization decisions (one query, no stored status). */
  async getInvocationRunAggregate(invocationId: string): Promise<InvocationRunAggregate> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status IN ('starting', 'running') THEN 1 ELSE 0 END), 0) AS active,
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
        failed: number;
        completed: number;
        skipped: number;
        last_completed_at: number | null;
      }>();

    return {
      total: row?.total ?? 0,
      active: row?.active ?? 0,
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
          `SELECT i.*,
                  ${DERIVED_INVOCATION_STATUS_SQL} AS derived_status,
                  ${DERIVED_INVOCATION_COMPLETED_AT_SQL} AS derived_completed_at
           FROM automation_invocations i
           LEFT JOIN automation_runs r ON r.invocation_id = i.id
           WHERE i.automation_id = ?
           GROUP BY i.id
           ORDER BY i.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(automationId, options.limit, options.offset),
    ]);

    const total = (countResult.results?.[0] as { count: number } | undefined)?.count ?? 0;
    const rows = (pageResult.results ?? []) as (AutomationInvocationRow & {
      derived_status: string;
      derived_completed_at: number | null;
    })[];
    if (rows.length === 0) return { invocations: [], total };

    const placeholders = rows.map(() => "?").join(", ");
    const childResult = await this.db
      .prepare(
        `SELECT r.*, s.title AS session_title, NULL AS artifact_summary
         FROM automation_runs r
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.invocation_id IN (${placeholders})
         ORDER BY r.created_at ASC`
      )
      .bind(...rows.map((row) => row.id))
      .all<EnrichedRunRow>();

    const childrenByInvocation = new Map<string, AutomationRun[]>();
    for (const child of childResult.results ?? []) {
      const invocationId = child.invocation_id!;
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

  /**
   * Flattened run list for the DEPRECATED GET /automations/:id/runs alias:
   * child runs in firing order plus VIRTUAL rows for childless skipped
   * invocations, shaped like the legacy skipped run rows (id = invocation id)
   * so stale web bundles keep a row per firing and their pagination math.
   * Firing keys are surfaced from the invocation for new rows. Removed with
   * the alias.
   */
  async listRunsFlattenedForAutomation(
    automationId: string,
    options: { limit: number; offset: number }
  ): Promise<{ runs: EnrichedRunRow[]; total: number }> {
    const [countResult, pageResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM automation_runs WHERE automation_id = ?)
             + (SELECT COUNT(*) FROM automation_invocations i
                WHERE i.automation_id = ? AND i.skip_reason IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM automation_runs r2 WHERE r2.invocation_id = i.id))
             AS count`
        )
        .bind(automationId, automationId),
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT r.id, r.automation_id, r.invocation_id, r.session_id, r.status,
                    r.skip_reason, r.failure_reason, r.scheduled_at, r.started_at,
                    r.completed_at, r.created_at,
                    COALESCE(i.trigger_key, r.trigger_key) AS trigger_key,
                    COALESCE(i.concurrency_key, r.concurrency_key) AS concurrency_key,
                    r.repo_owner, r.repo_name, r.repo_id, r.base_branch,
                    s.title AS session_title, NULL AS artifact_summary
             FROM automation_runs r
             LEFT JOIN automation_invocations i ON i.id = r.invocation_id
             LEFT JOIN sessions s ON r.session_id = s.id
             WHERE r.automation_id = ?
             UNION ALL
             SELECT i.id, i.automation_id, i.id, NULL, 'skipped',
                    i.skip_reason, NULL, COALESCE(i.scheduled_at, i.created_at), NULL,
                    i.created_at, i.created_at,
                    i.trigger_key,
                    i.concurrency_key,
                    NULL, NULL, NULL, NULL,
                    NULL, NULL
             FROM automation_invocations i
             WHERE i.automation_id = ? AND i.skip_reason IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM automation_runs r2 WHERE r2.invocation_id = i.id)
           )
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`
        )
        .bind(automationId, automationId, options.limit, options.offset),
    ]);

    const total = (countResult.results?.[0] as { count: number } | undefined)?.count ?? 0;
    return { runs: (pageResult.results ?? []) as EnrichedRunRow[], total };
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
             WHERE r.invocation_id = i.id AND r.status IN ('starting', 'running'))
         ORDER BY i.created_at ASC
         LIMIT ?`
      )
      .bind(sinceMs, limit)
      .all<AutomationInvocationRow>();
    return result.results || [];
  }

  /**
   * Automations still carrying consecutive_failures whose LATEST recent
   * non-skip invocation may be a fully-completed one (missed reset). The
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
    return result.results || [];
  }

  async getActiveRunForKey(
    automationId: string,
    concurrencyKey: string | null
  ): Promise<AutomationRunRow | null> {
    if (concurrencyKey === null) {
      return this.getActiveRunForAutomation(automationId);
    }
    // Keys live on the invocation; COALESCE additionally covers rows whose key
    // still sits on the run (rollback-window writes). Simplified away when the
    // frozen run columns are dropped.
    return this.db
      .prepare(
        `SELECT r.* FROM automation_runs r
         LEFT JOIN automation_invocations i ON i.id = r.invocation_id
         WHERE r.automation_id = ?
           AND COALESCE(i.concurrency_key, r.concurrency_key) = ?
           AND r.status IN ('starting', 'running')
         ORDER BY r.created_at DESC LIMIT 1`
      )
      .bind(automationId, concurrencyKey)
      .first<AutomationRunRow>();
  }

  /**
   * The most recent materialized run (any status, with a session) for a thread's
   * concurrency key, created at/after `sinceMs`. Powers Slack thread-session
   * continuity: a reply continues this run's session regardless of run status.
   * Excludes skipped rows and not-yet-started runs (session_id NULL). Backed by
   * idx_runs_thread_continuity (migration 0028).
   */
  async getLatestSteerableRunForThread(
    automationId: string,
    concurrencyKey: string | null,
    sinceMs: number
  ): Promise<AutomationRunRow | null> {
    if (concurrencyKey === null) return null;
    // Same key-location tolerance as getActiveRunForKey.
    return this.db
      .prepare(
        `SELECT r.* FROM automation_runs r
         LEFT JOIN automation_invocations i ON i.id = r.invocation_id
         WHERE r.automation_id = ?
           AND COALESCE(i.concurrency_key, r.concurrency_key) = ?
           AND r.session_id IS NOT NULL AND r.created_at >= ?
         ORDER BY r.created_at DESC LIMIT 1`
      )
      .bind(automationId, concurrencyKey, sinceMs)
      .first<AutomationRunRow>();
  }

  // --- Recovery sweep queries ---
  // Backed by partial indexes (migration 0024); `status` must stay a literal, not
  // a bound param, or the planner skips the index and full-scans automation_runs.
  static readonly ORPHANED_STARTING_RUNS_SQL =
    "SELECT * FROM automation_runs WHERE status = 'starting' AND created_at < ?";
  static readonly TIMED_OUT_RUNNING_RUNS_SQL =
    "SELECT * FROM automation_runs WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?";

  async getOrphanedStartingRuns(thresholdMs: number, limit: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db
      .prepare(`${AutomationStore.ORPHANED_STARTING_RUNS_SQL} ORDER BY created_at ASC LIMIT ?`)
      .bind(cutoff, limit)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  async getTimedOutRunningRuns(
    executionTimeoutMs: number,
    limit: number
  ): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - executionTimeoutMs;
    const result = await this.db
      .prepare(`${AutomationStore.TIMED_OUT_RUNNING_RUNS_SQL} ORDER BY started_at ASC LIMIT ?`)
      .bind(cutoff, limit)
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
