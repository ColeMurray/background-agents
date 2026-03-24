/**
 * AutomationStore — D1 persistence for automations and automation runs.
 *
 * Follows the same pattern as SessionIndexStore: constructor takes D1Database,
 * snake_case rows in the database, camelCase types at the API boundary.
 */

import type { Automation, AutomationRun, AutomationRunStatus } from "@open-inspect/shared";

// ─── Internal row types ──────────────────────────────────────────────────────

export interface AutomationRow {
  id: string;
  name: string;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
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
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  event_type: string | null;
  trigger_config: string | null; // JSON-serialized TriggerConfig
  webhook_secret_hash: string | null;
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
}

export interface EnrichedRunRow extends AutomationRunRow {
  session_title: string | null;
  artifact_summary: string | null;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    name: row.name,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    baseBranch: row.base_branch,
    repoId: row.repo_id,
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
    triggerConfig: row.trigger_config ? JSON.parse(row.trigger_config) : null,
  };
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
  };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class AutomationStore {
  constructor(private readonly db: D1Database) {}

  // --- Automation CRUD ---

  async create(row: AutomationRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO automations
         (id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
          trigger_type, schedule_cron, schedule_tz, model, reasoning_effort, enabled, next_run_at,
          consecutive_failures, created_by, created_at, updated_at, deleted_at,
          event_type, trigger_config, webhook_secret_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        row.created_at,
        row.updated_at,
        row.deleted_at,
        row.event_type,
        row.trigger_config,
        row.webhook_secret_hash
      )
      .run();
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
      conditions.push("repo_owner = ?");
      params.push(options.repoOwner.toLowerCase());
    }
    if (options.repoName) {
      conditions.push("repo_name = ?");
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

  async update(id: string, fields: Partial<AutomationRow>): Promise<AutomationRow | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const allowedFields: (keyof AutomationRow)[] = [
      "name",
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
      "webhook_secret_hash",
    ];

    for (const field of allowedFields) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push("updated_at = ?");
    params.push(Date.now());
    params.push(id);

    await this.db
      .prepare(
        `UPDATE automations SET ${setClauses.join(", ")} WHERE id = ? AND deleted_at IS NULL`
      )
      .bind(...params)
      .run();

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
          scheduled_at, started_at, completed_at, created_at, trigger_key, concurrency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        run.concurrency_key ?? null
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
      "started_at",
      "completed_at",
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

  async listRunsForAutomation(
    automationId: string,
    options: { limit: number; offset: number }
  ): Promise<{ runs: EnrichedRunRow[]; total: number }> {
    const countResult = await this.db
      .prepare("SELECT COUNT(*) as count FROM automation_runs WHERE automation_id = ?")
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
         WHERE r.automation_id = ?
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

  async getAutomationsForSentryEvent(eventType: string): Promise<AutomationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM automations
         WHERE trigger_type = 'sentry' AND event_type = ?
         AND enabled = 1 AND deleted_at IS NULL`
      )
      .bind(eventType)
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
    return this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE automation_id = ? AND concurrency_key = ? AND status IN ('starting', 'running')
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(automationId, concurrencyKey)
      .first<AutomationRunRow>();
  }

  // --- Recovery sweep queries ---

  async getOrphanedStartingRuns(thresholdMs: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE status = 'starting' AND created_at < ?`
      )
      .bind(cutoff)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  async getTimedOutRunningRuns(executionTimeoutMs: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - executionTimeoutMs;
    const result = await this.db
      .prepare(
        `SELECT * FROM automation_runs
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`
      )
      .bind(cutoff)
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
