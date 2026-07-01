/**
 * AutomationStore — D1 persistence for automations and automation runs.
 *
 * Follows the same pattern as SessionIndexStore: constructor takes D1Database,
 * snake_case rows in the database, camelCase types at the API boundary.
 */

import type {
  Automation,
  AutomationRun,
  AutomationRunGroup,
  AutomationRunGroupStatus,
  AutomationRunStatus,
  AutomationTarget,
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
  session_id: string | null;
  status: AutomationRunStatus;
  skip_reason: string | null;
  failure_reason: string | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  trigger_key: string | null;
  concurrency_key: string | null;
  group_id?: string | null;
  target_repo_owner?: string | null;
  target_repo_name?: string | null;
  target_repo_id?: number | null;
  target_base_branch?: string | null;
  // Source-specific run metadata as JSON (slack-origin runs only today; absent
  // otherwise). Opaque to the store — interpreted by the owning source's layer.
  trigger_run_metadata?: string | null;
}

export interface EnrichedRunRow extends AutomationRunRow {
  session_title: string | null;
  artifact_summary: string | null;
}

export interface AutomationTargetRow {
  automation_id: string;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunGroupRow {
  id: string;
  automation_id: string;
  status: AutomationRunGroupStatus;
  skip_reason: string | null;
  failure_reason: string | null;
  scheduled_at: number;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  failure_counted_at: number | null;
  expected_runs: number;
}

export interface EnrichedRunGroupRow extends AutomationRunGroupRow {
  materialized_runs: number;
  total_runs: number;
  starting_runs: number;
  running_runs: number;
  completed_runs: number;
  failed_runs: number;
  skipped_runs: number;
  runs?: EnrichedRunRow[];
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function toAutomation(
  row: AutomationRow,
  targetRows: AutomationTargetRow[] = []
): Automation {
  const triggerConfig: TriggerConfig | null = row.trigger_config
    ? JSON.parse(row.trigger_config)
    : null;

  if ((row.repo_owner === null) !== (row.repo_name === null)) {
    throw new Error("Automation repository target must include repo_owner and repo_name together");
  }

  const hasRepository = row.repo_owner !== null && row.repo_name !== null;
  const targets: AutomationTarget[] = targetRows.map(toAutomationTarget);
  if (targets.length === 0 && row.repo_owner !== null && row.repo_name !== null) {
    targets.push({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      repoId: row.repo_id,
      baseBranch: row.base_branch,
    });
  }

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
    targets,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: hasRepository ? row.base_branch : null,
    repoId: hasRepository ? row.repo_id : null,
  };
}

function assertAutomationRepositoryFields(row: Partial<AutomationRow>): void {
  const repoOwnerProvided = "repo_owner" in row;
  const repoNameProvided = "repo_name" in row;

  if (repoOwnerProvided !== repoNameProvided) {
    throw new Error("Automation repository target must include repo_owner and repo_name together");
  }

  if (!repoOwnerProvided || !repoNameProvided) return;

  const repoOwner = row.repo_owner ?? null;
  const repoName = row.repo_name ?? null;

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Automation repository target must include repo_owner and repo_name together");
  }

  if (repoOwner === null && (row.base_branch != null || row.repo_id != null)) {
    throw new Error("Automation base_branch and repo_id require repository context");
  }
}

export function toAutomationRun(row: EnrichedRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
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
    groupId: row.group_id ?? null,
    targetRepoOwner: row.target_repo_owner ?? null,
    targetRepoName: row.target_repo_name ?? null,
    targetRepoId: row.target_repo_id ?? null,
    targetBaseBranch: row.target_base_branch ?? null,
  };
}

export function toAutomationTarget(row: AutomationTargetRow): AutomationTarget {
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoId: row.repo_id,
    baseBranch: row.base_branch,
  };
}

export function toAutomationRunGroup(row: EnrichedRunGroupRow): AutomationRunGroup {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status,
    skipReason: row.skip_reason,
    failureReason: row.failure_reason,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureCountedAt: row.failure_counted_at,
    totalRuns: row.total_runs,
    startingRuns: row.starting_runs,
    runningRuns: row.running_runs,
    completedRuns: row.completed_runs,
    failedRuns: row.failed_runs,
    skippedRuns: row.skipped_runs,
    runs: (row.runs ?? []).map(toAutomationRun),
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

  bindTargetInsert(row: AutomationTargetRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO automation_targets
         (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.automation_id,
        row.repo_owner,
        row.repo_name,
        row.repo_id,
        row.base_branch,
        row.created_at,
        row.updated_at
      );
  }

  async createWithTargets(row: AutomationRow, targets: AutomationTargetRow[]): Promise<void> {
    await this.db.batch([
      this.bindAutomationInsert(row),
      ...targets.map((target) => this.bindTargetInsert(target)),
    ]);
  }

  async getById(id: string): Promise<AutomationRow | null> {
    return this.db
      .prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL")
      .bind(id)
      .first<AutomationRow>();
  }

  async getTargetsForAutomation(automationId: string): Promise<AutomationTargetRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_targets
         WHERE automation_id = ?
         ORDER BY repo_owner ASC, repo_name ASC`
      )
      .bind(automationId)
      .all<AutomationTargetRow>();
    return result.results || [];
  }

  async getTargetsForAutomationIds(
    automationIds: string[]
  ): Promise<Map<string, AutomationTargetRow[]>> {
    const targetsByAutomation = new Map<string, AutomationTargetRow[]>();
    if (automationIds.length === 0) return targetsByAutomation;

    const batchSize = 100;
    for (let start = 0; start < automationIds.length; start += batchSize) {
      const chunk = automationIds.slice(start, start + batchSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db
        .prepare(
          `SELECT * FROM automation_targets
           WHERE automation_id IN (${placeholders})
           ORDER BY repo_owner ASC, repo_name ASC`
        )
        .bind(...chunk)
        .all<AutomationTargetRow>();

      for (const row of result.results || []) {
        const rows = targetsByAutomation.get(row.automation_id) ?? [];
        rows.push(row);
        targetsByAutomation.set(row.automation_id, rows);
      }
    }
    return targetsByAutomation;
  }

  async list(
    options: { repoOwner?: string; repoName?: string } = {}
  ): Promise<{ automations: AutomationRow[]; total: number }> {
    const repoOwner = options.repoOwner?.toLowerCase();
    const repoName = options.repoName?.toLowerCase();

    if (!repoOwner && !repoName) {
      const result = await this.db
        .prepare("SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC")
        .all<AutomationRow>();

      const automations = result.results || [];
      return { automations, total: automations.length };
    }

    const directConditions: string[] = ["deleted_at IS NULL"];
    const directParams: unknown[] = [];
    const targetConditions: string[] = ["a.deleted_at IS NULL"];
    const targetParams: unknown[] = [];

    if (repoOwner) {
      directConditions.push("repo_owner = ?");
      directParams.push(repoOwner);
      targetConditions.push("t.repo_owner = ?");
      targetParams.push(repoOwner);
    }
    if (repoName) {
      directConditions.push("repo_name = ?");
      directParams.push(repoName);
      targetConditions.push("t.repo_name = ?");
      targetParams.push(repoName);
    }

    const result = await this.db
      .prepare(
        `WITH matched_ids AS (
           SELECT id
           FROM automations
           WHERE ${directConditions.join(" AND ")}
           UNION
           SELECT t.automation_id AS id
           FROM automation_targets t
           INNER JOIN automations a ON a.id = t.automation_id
           WHERE ${targetConditions.join(" AND ")}
         )
         SELECT a.*
         FROM automations a
         INNER JOIN matched_ids m ON m.id = a.id
         ORDER BY a.created_at DESC`
      )
      .bind(...directParams, ...targetParams)
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
    assertAutomationRepositoryFields(fields);

    const setClauses: string[] = [];
    const params: unknown[] = [];

    const allowedFields: (keyof AutomationRow)[] = [
      "name",
      "repo_owner",
      "repo_name",
      "repo_id",
      "instructions",
      "schedule_cron",
      "schedule_tz",
      "model",
      "reasoning_effort",
      "base_branch",
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

  bindTargetDelete(automationId: string): D1PreparedStatement {
    return this.db
      .prepare("DELETE FROM automation_targets WHERE automation_id = ?")
      .bind(automationId);
  }

  async updateWithTargets(
    id: string,
    fields: Partial<AutomationRow>,
    targets: AutomationTargetRow[]
  ): Promise<AutomationRow | null> {
    const updateStatement = this.bindAutomationUpdate(id, fields);
    const statements = [
      ...(updateStatement ? [updateStatement] : []),
      this.bindTargetDelete(id),
      ...targets.map((target) => this.bindTargetInsert(target)),
    ];
    await this.db.batch(statements);
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

  private bindRunInsert(run: AutomationRunRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO automation_runs
         (id, automation_id, session_id, status, skip_reason, failure_reason,
          scheduled_at, started_at, completed_at, created_at, trigger_key, concurrency_key,
          trigger_run_metadata, group_id, target_repo_owner, target_repo_name, target_repo_id,
          target_base_branch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        run.id,
        run.automation_id,
        run.session_id,
        run.status,
        run.skip_reason,
        run.failure_reason,
        run.scheduled_at,
        run.started_at,
        run.completed_at,
        run.created_at,
        run.trigger_key ?? null,
        run.concurrency_key ?? null,
        run.trigger_run_metadata ?? null,
        run.group_id ?? null,
        run.target_repo_owner ?? null,
        run.target_repo_name ?? null,
        run.target_repo_id ?? null,
        run.target_base_branch ?? null
      );
  }

  async createRunAndAdvanceSchedule(
    run: AutomationRunRow,
    automationId: string,
    nextRunAt: number
  ): Promise<void> {
    const advanceSchedule = this.db
      .prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .bind(nextRunAt, Date.now(), automationId);

    await this.db.batch([this.bindRunInsert(run), advanceSchedule]);
  }

  private bindRunGroupInsert(group: AutomationRunGroupRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO automation_run_groups
         (id, automation_id, status, skip_reason, failure_reason, scheduled_at, started_at,
          completed_at, created_at, updated_at, failure_counted_at, expected_runs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        group.id,
        group.automation_id,
        group.status,
        group.skip_reason,
        group.failure_reason,
        group.scheduled_at,
        group.started_at,
        group.completed_at,
        group.created_at,
        group.updated_at,
        group.failure_counted_at,
        group.expected_runs
      );
  }

  async createRunGroupAndAdvanceSchedule(
    group: AutomationRunGroupRow,
    automationId: string,
    nextRunAt: number
  ): Promise<void> {
    const advanceSchedule = this.db
      .prepare("UPDATE automations SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .bind(nextRunAt, Date.now(), automationId);

    await this.db.batch([this.bindRunGroupInsert(group), advanceSchedule]);
  }

  async failRunGroup(groupId: string, reason: string, completedAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE automation_run_groups
         SET status = 'failed',
             failure_reason = ?,
             completed_at = ?,
             updated_at = ?
         WHERE id = ?
           AND (
             status IN ('starting', 'running')
             OR (status = 'partial_failed' AND completed_at IS NULL)
           )`
      )
      .bind(reason, completedAt, completedAt, groupId)
      .run();
  }

  async insertRunGroup(group: AutomationRunGroupRow): Promise<void> {
    await this.bindRunGroupInsert(group).run();
  }

  async insertRun(run: AutomationRunRow): Promise<void> {
    await this.bindRunInsert(run).run();
  }

  async updateRun(id: string, fields: Partial<AutomationRunRow>): Promise<void> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const allowedFields: (keyof AutomationRunRow)[] = [
      "session_id",
      "status",
      "failure_reason",
      "skip_reason",
      "started_at",
      "completed_at",
      "target_repo_owner",
      "target_repo_name",
      "target_repo_id",
      "target_base_branch",
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (setClauses.length === 0) return;

    params.push(id);

    await this.db
      .prepare(`UPDATE automation_runs SET ${setClauses.join(", ")} WHERE id = ?`)
      .bind(...params)
      .run();
  }

  private bindRunGroupUpdate(
    id: string,
    fields: Partial<AutomationRunGroupRow>
  ): D1PreparedStatement | null {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const allowedFields: (keyof AutomationRunGroupRow)[] = [
      "status",
      "skip_reason",
      "failure_reason",
      "started_at",
      "completed_at",
      "failure_counted_at",
      "expected_runs",
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push("updated_at = ?");
    params.push(Date.now(), id);

    return this.db
      .prepare(`UPDATE automation_run_groups SET ${setClauses.join(", ")} WHERE id = ?`)
      .bind(...params);
  }

  async updateRunGroup(id: string, fields: Partial<AutomationRunGroupRow>): Promise<void> {
    const statement = this.bindRunGroupUpdate(id, fields);
    if (statement) await statement.run();
  }

  async materializeRunGroupChildren(
    groupId: string,
    expectedRuns: number,
    runs: AutomationRunRow[]
  ): Promise<void> {
    const updateGroup = this.bindRunGroupUpdate(groupId, { expected_runs: expectedRuns });
    await this.db.batch([
      ...(updateGroup ? [updateGroup] : []),
      ...runs.map((run) => this.bindRunInsert(run)),
    ]);
  }

  async getActiveRunGroupForAutomation(
    automationId: string
  ): Promise<AutomationRunGroupRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM automation_run_groups
         WHERE automation_id = ?
           AND (
             status IN ('starting', 'running')
             OR (status = 'partial_failed' AND completed_at IS NULL)
           )
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(automationId)
      .first<AutomationRunGroupRow>();
  }

  async tryMarkRunGroupFailureCounted(groupId: string, countedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE automation_run_groups
         SET failure_counted_at = ?, updated_at = ?
         WHERE id = ? AND failure_counted_at IS NULL`
      )
      .bind(countedAt, countedAt, groupId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async bulkFailRuns(runIds: string[], reason: string, completedAt: number): Promise<void> {
    if (runIds.length === 0) return;
    const placeholders = runIds.map(() => "?").join(", ");
    await this.db
      .prepare(
        `UPDATE automation_runs
         SET status = 'failed', failure_reason = ?, completed_at = ?
         WHERE id IN (${placeholders})`
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

  async hasRunHistory(automationId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `SELECT EXISTS (
           SELECT 1 FROM automation_runs WHERE automation_id = ?
           UNION ALL
           SELECT 1 FROM automation_run_groups WHERE automation_id = ?
         ) as has_history`
      )
      .bind(automationId, automationId)
      .first<{ has_history: number }>();

    return (result?.has_history ?? 0) === 1;
  }

  async listRunsForAutomation(
    automationId: string,
    options: { limit: number; offset: number }
  ): Promise<{ runs: EnrichedRunRow[]; total: number }> {
    const countResult = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM automation_runs
         WHERE automation_id = ? AND group_id IS NULL`
      )
      .bind(automationId)
      .first<{ count: number }>();

    const total = countResult?.count ?? 0;

    const result = await this.db
      .prepare(
        `SELECT
           r.*,
           s.title as session_title,
           NULL as artifact_summary
         FROM automation_runs r
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.automation_id = ? AND r.group_id IS NULL
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(automationId, options.limit, options.offset)
      .all<EnrichedRunRow>();

    return { runs: result.results || [], total };
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

  async listRunGroupsForAutomation(
    automationId: string,
    options: { limit: number; offset: number }
  ): Promise<{ groups: EnrichedRunGroupRow[]; total: number }> {
    const countResult = await this.db
      .prepare("SELECT COUNT(*) as count FROM automation_run_groups WHERE automation_id = ?")
      .bind(automationId)
      .first<{ count: number }>();
    const total = countResult?.count ?? 0;

    const result = await this.db
      .prepare(
        `WITH page AS (
           SELECT *
           FROM automation_run_groups
           WHERE automation_id = ?
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?
         )
         SELECT
           page.*,
           COUNT(r.id) as materialized_runs,
           CASE
             WHEN page.expected_runs > COUNT(r.id) THEN page.expected_runs
             ELSE COUNT(r.id)
           END as total_runs,
           COALESCE(SUM(CASE WHEN r.status = 'starting' THEN 1 ELSE 0 END), 0) as starting_runs,
           COALESCE(SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END), 0) as running_runs,
           COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END), 0) as completed_runs,
           COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) as failed_runs,
           COALESCE(SUM(CASE WHEN r.status = 'skipped' THEN 1 ELSE 0 END), 0) as skipped_runs
         FROM page
         LEFT JOIN automation_runs r ON r.group_id = page.id
         GROUP BY page.id
         ORDER BY page.created_at DESC`
      )
      .bind(automationId, options.limit, options.offset)
      .all<EnrichedRunGroupRow>();

    const groups = result.results || [];
    await this.attachRunsToGroups(groups);
    return { groups, total };
  }

  async getRunGroupSummary(groupId: string): Promise<EnrichedRunGroupRow | null> {
    return this.db
      .prepare(
        `SELECT
           g.*,
           COUNT(r.id) as materialized_runs,
           CASE
             WHEN g.expected_runs > COUNT(r.id) THEN g.expected_runs
             ELSE COUNT(r.id)
           END as total_runs,
           COALESCE(SUM(CASE WHEN r.status = 'starting' THEN 1 ELSE 0 END), 0) as starting_runs,
           COALESCE(SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END), 0) as running_runs,
           COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END), 0) as completed_runs,
           COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) as failed_runs,
           COALESCE(SUM(CASE WHEN r.status = 'skipped' THEN 1 ELSE 0 END), 0) as skipped_runs
         FROM automation_run_groups g
         LEFT JOIN automation_runs r ON r.group_id = g.id
         WHERE g.id = ?
         GROUP BY g.id`
      )
      .bind(groupId)
      .first<EnrichedRunGroupRow>();
  }

  async listRunsForGroup(groupId: string): Promise<EnrichedRunRow[]> {
    const result = await this.db
      .prepare(
        `SELECT
           r.*,
           s.title as session_title,
           NULL as artifact_summary
         FROM automation_runs r
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.group_id = ?
         ORDER BY r.created_at ASC`
      )
      .bind(groupId)
      .all<EnrichedRunRow>();
    return result.results || [];
  }

  private async attachRunsToGroups(groups: EnrichedRunGroupRow[]): Promise<void> {
    if (groups.length === 0) return;

    const groupIds = groups.map((group) => group.id);
    const placeholders = groupIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT
           r.*,
           s.title as session_title,
           NULL as artifact_summary
         FROM automation_runs r
         LEFT JOIN sessions s ON r.session_id = s.id
         WHERE r.group_id IN (${placeholders})
         ORDER BY r.created_at ASC`
      )
      .bind(...groupIds)
      .all<EnrichedRunRow>();

    const runsByGroup = new Map<string, EnrichedRunRow[]>();
    for (const run of result.results || []) {
      if (!run.group_id) continue;
      const runs = runsByGroup.get(run.group_id) ?? [];
      runs.push(run);
      runsByGroup.set(run.group_id, runs);
    }

    for (const group of groups) {
      group.runs = runsByGroup.get(group.id) ?? [];
    }
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
        `SELECT * FROM automations
         WHERE repo_owner = ? AND repo_name = ? AND trigger_type = ? AND event_type = ?
         AND enabled = 1 AND deleted_at IS NULL`
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase(), triggerType, eventType)
      .all<AutomationRow>();
    return result.results || [];
  }

  /**
   * Record a `skipped` run for observability (concurrency skips).
   * Leaves trigger_key null so repeated skips never collide on the dedup index
   * (NULLs are distinct under the unique automation_id/trigger_key index).
   * `runMetadata` carries the run's source-specific metadata as a unit — the same
   * value a materialized run is inserted with — so there is no re-mapping.
   */
  async recordSkippedRun(params: {
    id: string;
    automationId: string;
    skipReason: string;
    concurrencyKey?: string | null;
    runMetadata?: Pick<AutomationRunRow, "trigger_run_metadata">;
  }): Promise<void> {
    const now = Date.now();
    try {
      await this.insertRun({
        id: params.id,
        automation_id: params.automationId,
        session_id: null,
        status: "skipped",
        skip_reason: params.skipReason,
        failure_reason: null,
        scheduled_at: now,
        started_at: null,
        completed_at: now,
        created_at: now,
        trigger_key: null,
        concurrency_key: params.concurrencyKey ?? null,
        ...params.runMetadata,
      });
    } catch (e) {
      // Defensive only: the insert uses a fresh unique id and a null trigger_key
      // (NULLs are distinct under the unique automation_id/trigger_key index), so
      // a collision is not expected. Swallow one anyway so best-effort skip
      // bookkeeping never throws into the dispatch path.
      if (isDuplicateKeyError(e)) return;
      throw e;
    }
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
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND concurrency_key = ? AND status IN ('starting', 'running')
         ORDER BY created_at DESC LIMIT 1`
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
    return this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND concurrency_key = ?
           AND session_id IS NOT NULL AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`
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
  static readonly ORPHANED_ACTIVE_RUN_GROUPS_SQL = `SELECT * FROM automation_run_groups g
     WHERE (g.status IN ('starting', 'running') OR (g.status = 'partial_failed' AND g.completed_at IS NULL))
       AND g.created_at < ?
       AND (
         NOT EXISTS (
           SELECT 1 FROM automation_runs r WHERE r.group_id = g.id
         )
         OR (
           g.expected_runs > 0
           AND (
             SELECT COUNT(*)
             FROM automation_runs r
             WHERE r.group_id = g.id
           ) < g.expected_runs
         )
       )`;

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

  async getOrphanedActiveRunGroups(
    thresholdMs: number,
    limit: number
  ): Promise<AutomationRunGroupRow[]> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db
      .prepare(
        `${AutomationStore.ORPHANED_ACTIVE_RUN_GROUPS_SQL} ORDER BY g.created_at ASC LIMIT ?`
      )
      .bind(cutoff, limit)
      .all<AutomationRunGroupRow>();
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
 * True when a D1 write failed because it violated the trigger-key dedup index
 * (`idx_runs_trigger_key` on `automation_id, trigger_key` — the only UNIQUE on
 * `automation_runs`). Scoping to the `trigger_key` column keeps unrelated UNIQUE
 * violations surfacing as real errors instead of being silently swallowed as
 * duplicates, while matching the column name (not D1's full
 * `table.col, table.col` string) stays robust to exact message formatting.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") && message.includes("trigger_key");
}
