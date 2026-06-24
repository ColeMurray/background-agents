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
  user_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  event_type: string | null;
  trigger_config: string | null; // JSON-serialized TriggerConfig
  trigger_auth_data: string | null;
  /** Slack triggers (#716): per-automation hourly run cap (null = app default). */
  max_runs_per_hour?: number | null;
  /** Slack triggers (#716): post the run result back into the thread (1/0). */
  reply_in_thread?: number;
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
  // Slack triggers (#716): thread coordinates + posting actor (slack-origin runs only).
  slack_channel?: string | null;
  slack_thread_ts?: string | null;
  slack_message_ts?: string | null;
  actor_user_id?: string | null;
}

export interface EnrichedRunRow extends AutomationRunRow {
  session_title: string | null;
  artifact_summary: string | null;
}

/** The slack thread-coordinate columns of a run row, set together for slack-origin runs. */
export type SlackRunColumns = Pick<
  AutomationRunRow,
  "slack_channel" | "slack_thread_ts" | "slack_message_ts" | "actor_user_id"
>;

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
    maxRunsPerHour: row.max_runs_per_hour ?? null,
    replyInThread: row.reply_in_thread == null ? true : row.reply_in_thread === 1,
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

  private bindAutomationInsert(row: AutomationRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO automations
         (id, name, repo_owner, repo_name, base_branch, repo_id, instructions,
          trigger_type, schedule_cron, schedule_tz, model, reasoning_effort, enabled, next_run_at,
          consecutive_failures, created_by, user_id, created_at, updated_at, deleted_at,
          event_type, trigger_config, trigger_auth_data, max_runs_per_hour, reply_in_thread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        row.trigger_auth_data,
        row.max_runs_per_hour ?? null,
        row.reply_in_thread ?? 1
      );
  }

  async create(row: AutomationRow): Promise<void> {
    await this.bindAutomationInsert(row).run();
  }

  /**
   * Atomically insert an automation and its watched slack channels in one
   * `db.batch`, so a slack_event automation can never be committed without its
   * channel-index rows (which would leave it invisible to the scheduler).
   */
  async createWithSlackChannels(row: AutomationRow, channelIds: string[]): Promise<void> {
    await this.db.batch([
      this.bindAutomationInsert(row),
      ...this.bindSlackChannelStatements(row.id, channelIds),
    ]);
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

  /**
   * Build the dynamic UPDATE statement for the allowed automation fields, or
   * null when `fields` carries nothing to write.
   */
  private bindAutomationUpdate(
    id: string,
    fields: Partial<AutomationRow>
  ): D1PreparedStatement | null {
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
      "trigger_auth_data",
      "max_runs_per_hour",
      "reply_in_thread",
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

  /**
   * Atomically update an automation and re-sync its watched slack channels in
   * one `db.batch`, so the canonical `trigger_config` and the channel index can
   * never drift apart on a partial failure.
   */
  async updateWithSlackChannels(
    id: string,
    fields: Partial<AutomationRow>,
    channelIds: string[]
  ): Promise<AutomationRow | null> {
    const updateStatement = this.bindAutomationUpdate(id, fields);
    const channelStatements = this.bindSlackChannelStatements(id, channelIds);
    await this.db.batch(
      updateStatement ? [updateStatement, ...channelStatements] : channelStatements
    );
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
          slack_channel, slack_thread_ts, slack_message_ts, actor_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        run.slack_channel ?? null,
        run.slack_thread_ts ?? null,
        run.slack_message_ts ?? null,
        run.actor_user_id ?? null
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

  // --- Slack trigger queries (#716) ---

  /** Enabled, non-deleted slack_event automations watching a channel (indexed by channel_id). */
  async getSlackAutomationsForChannel(channelId: string): Promise<AutomationRow[]> {
    const result = await this.db
      .prepare(
        `SELECT a.* FROM automations a
         JOIN automation_slack_channels c ON c.automation_id = a.id
         WHERE c.channel_id = ? AND a.enabled = 1 AND a.deleted_at IS NULL
           AND a.trigger_type = 'slack_event'`
      )
      .bind(channelId)
      .all<AutomationRow>();
    return result.results || [];
  }

  /** Distinct channel IDs watched by any enabled slack_event automation. */
  async getWatchedSlackChannels(): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT c.channel_id FROM automation_slack_channels c
         JOIN automations a ON a.id = c.automation_id
         WHERE a.enabled = 1 AND a.deleted_at IS NULL AND a.trigger_type = 'slack_event'`
      )
      .all<{ channel_id: string }>();
    return (result.results || []).map((r) => r.channel_id);
  }

  /** Replace an automation's watched-channel set atomically. */
  /** Statements that replace an automation's watched-channel set (DELETE + re-INSERT). */
  private bindSlackChannelStatements(
    automationId: string,
    channelIds: string[]
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare("DELETE FROM automation_slack_channels WHERE automation_id = ?")
        .bind(automationId),
    ];
    for (const channelId of channelIds) {
      statements.push(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO automation_slack_channels (automation_id, channel_id) VALUES (?, ?)"
          )
          .bind(automationId, channelId)
      );
    }
    return statements;
  }

  async setSlackChannels(automationId: string, channelIds: string[]): Promise<void> {
    await this.db.batch(this.bindSlackChannelStatements(automationId, channelIds));
  }

  /**
   * Count runs for an automation since `sinceEpochMs`, for the rate-limit window.
   * Excludes `skipped` rows — only runs that materialized a session count (a
   * `failed` run still spawned a sandbox, so it counts). Served by
   * idx_runs_automation_created (automation_id, created_at).
   */
  async countRunsInWindow(automationId: string, sinceEpochMs: number): Promise<number> {
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM automation_runs
         WHERE automation_id = ? AND created_at >= ? AND status != 'skipped'`
      )
      .bind(automationId, sinceEpochMs)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /**
   * Record a `skipped` run for observability (rate-limited / concurrency skips).
   * Leaves trigger_key null so the skip stays excluded from countRunsInWindow.
   * `slackColumns` carries the run's thread coordinates as a unit — the same
   * value a materialized run is inserted with — so there is no re-mapping.
   */
  async recordSkippedRun(params: {
    id: string;
    automationId: string;
    skipReason: string;
    concurrencyKey?: string | null;
    slackColumns?: SlackRunColumns;
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
        ...params.slackColumns,
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

  // --- Recovery sweep queries ---
  // Backed by partial indexes (migration 0024); `status` must stay a literal, not
  // a bound param, or the planner skips the index and full-scans automation_runs.
  static readonly ORPHANED_STARTING_RUNS_SQL =
    "SELECT * FROM automation_runs WHERE status = 'starting' AND created_at < ?";
  static readonly TIMED_OUT_RUNNING_RUNS_SQL =
    "SELECT * FROM automation_runs WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?";

  async getOrphanedStartingRuns(thresholdMs: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - thresholdMs;
    const result = await this.db
      .prepare(AutomationStore.ORPHANED_STARTING_RUNS_SQL)
      .bind(cutoff)
      .all<AutomationRunRow>();
    return result.results || [];
  }

  async getTimedOutRunningRuns(executionTimeoutMs: number): Promise<AutomationRunRow[]> {
    const cutoff = Date.now() - executionTimeoutMs;
    const result = await this.db
      .prepare(AutomationStore.TIMED_OUT_RUNNING_RUNS_SQL)
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
