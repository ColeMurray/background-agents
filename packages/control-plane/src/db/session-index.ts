import type {
  PullRequestSummary,
  SessionReadAction,
  SessionReadResult,
  SessionReadState,
  SessionStatus,
  SpawnSource,
} from "@open-inspect/shared/types/sessions";
import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_LIST_OFFSET,
} from "@open-inspect/shared/session-list-query";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import {
  sessionModelProviderAuthSchema,
  SUBSCRIPTION_PROVIDER_IDS,
} from "@open-inspect/shared/types/provider-accounts";
import type { SessionSkillManifestInput } from "../session/skill-resolution";
import {
  assertProviderAuthSelection,
  type ModelProviderId,
  type SessionModelProviderAuthInput,
} from "../model-provider-accounts/provider-auth-contracts";
import { bulkInsertStatements } from "./bulk-insert";
import { attachSessionListMetadata } from "./session-list-metadata";
import {
  SessionInboxStore,
  type ListSessionInboxOptions,
  type ListSessionInboxResult,
  type ListSessionInboxSnapshotResult,
} from "./session-inbox-store";
import { INACTIVE_SESSION_STATUS_SQL } from "@open-inspect/shared/types/session-activity";
import { readStateFromRow, unreadSql, type ViewerReadStateRow } from "./session-read-state";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const CHILD_ADMISSION_LEASE_TTL_MS = 5 * 60 * 1000;

export interface ChildAdmissionLease {
  token: string;
  childSessionId: string;
  expiresAt: number;
}

/**
 * Insurance against a corrupt parent_session_id cycle making the recursive
 * descendant CTE run away; spawn-time depth caps keep real trees far below it.
 */
const MAX_DESCENDANT_DEPTH = 10;

/**
 * One member of a session's repository set — the identity subset of the
 * shared SessionRepositoryState (no git state; D1 doesn't store it).
 * Ordered — array position is the persisted `position` column ([0] =
 * primary, mirrored into the scalar repo_owner/repo_name columns). Aliases
 * the shared wire type so Session.repositories and this share one shape.
 */
type SessionIndexRepository = SessionListRepository;

/** Persisted session metadata with optional viewer-specific read state. */
export interface SessionEntry {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  model: string;
  reasoningEffort: string | null;
  baseBranch: string | null;
  status: SessionStatus;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  automationId?: string | null;
  automationRunId?: string | null;
  scmLogin?: string | null;
  userId?: string | null;
  totalCost?: number;
  activeDurationMs?: number;
  messageCount?: number;
  prCount?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Ordered member list; [0] = primary. Absent on pre-feature sessions —
   * consumers synthesize from repoOwner/repoName.
   */
  repositories?: SessionIndexRepository[];
  /**
   * The environment this session was launched from (provenance), or null for
   * repo-launched/ad-hoc sessions. PR-12 renders it on the session list.
   */
  environmentId?: string | null;
  /**
   * Per-status PR counts from session_pull_requests; absent when the session
   * has no tracked PRs. Attached by list() for the global sidebar.
   */
  pullRequestSummary?: PullRequestSummary;
  readState?: SessionReadState;
  /** Resolved manifest to persist atomically with a new top-level session. */
  skillManifest?: SessionSkillManifestInput;
  /** Parent manifest to copy atomically for an agent-spawned child. */
  skillManifestSourceSessionId?: string;
  /** Complete immutable model-provider authentication snapshot. */
  providerAuth?: SessionModelProviderAuthInput[];
}

interface SessionRow {
  id: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  model: string;
  reasoning_effort: string | null;
  base_branch: string | null;
  status: SessionStatus;
  parent_session_id: string | null;
  root_session_id: string | null;
  spawn_source: SpawnSource;
  spawn_depth: number;
  automation_id: string | null;
  automation_run_id: string | null;
  scm_login: string | null;
  user_id: string | null;
  total_cost: number;
  active_duration_ms: number;
  message_count: number;
  pr_count: number;
  environment_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SessionModelProviderAuthRow {
  provider: string;
  auth_mode: string;
  provider_account_id: string | null;
  selection_source: string;
  inherited_from_session_id: string | null;
}

/** Filters, pagination, and viewer read state for a session list query. */
export interface ListSessionsOptions {
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  excludeAutomationLineage?: boolean;
  createdByUserIds?: readonly string[];
  limit?: number;
  offset?: number;
  viewerUserId?: string;
}

/** Paginated session index entries. */
export interface ListSessionsResult {
  sessions: SessionEntry[];
  hasMore: boolean;
}

type ViewerSessionRow = SessionRow & ViewerReadStateRow;

function toEntry(row: SessionRow): SessionEntry {
  return {
    id: row.id,
    title: row.title,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    baseBranch: row.base_branch,
    status: row.status,
    parentSessionId: row.parent_session_id,
    spawnSource: row.spawn_source,
    spawnDepth: row.spawn_depth,
    automationId: row.automation_id,
    automationRunId: row.automation_run_id,
    scmLogin: row.scm_login,
    userId: row.user_id,
    totalCost: row.total_cost,
    activeDurationMs: row.active_duration_ms,
    messageCount: row.message_count,
    prCount: row.pr_count,
    environmentId: row.environment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProviderAuth(row: SessionModelProviderAuthRow): SessionModelProviderAuthInput {
  const auth = sessionModelProviderAuthSchema.parse({
    provider: row.provider,
    authMode: row.auth_mode,
    ...(row.provider_account_id ? { providerAccountId: row.provider_account_id } : {}),
    selectionSource: row.selection_source,
  });
  return {
    ...auth,
    ...(row.inherited_from_session_id
      ? { inheritedFromSessionId: row.inherited_from_session_id }
      : {}),
  };
}

function isCompleteProviderAuth(providerAuth: readonly SessionModelProviderAuthInput[]): boolean {
  return (
    providerAuth.length === SUBSCRIPTION_PROVIDER_IDS.length &&
    SUBSCRIPTION_PROVIDER_IDS.every((provider) =>
      providerAuth.some((auth) => auth.provider === provider)
    )
  );
}

function normalizeRepoIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeSessionRepositoryFields(session: SessionEntry): {
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
} {
  const repoOwner = normalizeRepoIdentifier(session.repoOwner);
  const repoName = normalizeRepoIdentifier(session.repoName);

  if ((repoOwner === null) !== (repoName === null)) {
    throw new Error("Session repository must include repoOwner and repoName together");
  }

  return {
    repoOwner,
    repoName,
    baseBranch: repoOwner && repoName ? session.baseBranch : null,
  };
}

/** D1-backed session index and viewer-specific list projection. */
export class SessionIndexStore {
  constructor(private readonly db: SqlDatabase) {}

  async exists(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("SELECT 1 AS ok FROM sessions WHERE id = ?")
      .bind(id)
      .first<{ ok: number }>();
    return result !== null;
  }

  async create(session: SessionEntry): Promise<void> {
    const repository = normalizeSessionRepositoryFields(session);

    if (session.skillManifest && session.skillManifestSourceSessionId) {
      throw new Error("Session cannot both resolve and copy a managed skill manifest");
    }

    const providers = new Set<string>();
    for (const auth of session.providerAuth ?? []) {
      assertProviderAuthSelection(
        auth.provider,
        auth.authMode,
        "providerAccountId" in auth ? auth.providerAccountId : null
      );
      if (providers.has(auth.provider))
        throw new Error(`Duplicate provider auth: ${auth.provider}`);
      providers.add(auth.provider);
    }
    if (session.providerAuth && !isCompleteProviderAuth(session.providerAuth)) {
      throw new Error("Session provider auth snapshot must include every subscription provider");
    }

    const sessionStmt = this.db
      .prepare(
        `INSERT INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, base_branch, status, parent_session_id, root_session_id, spawn_source, spawn_depth, automation_id, automation_run_id, scm_login, user_id, environment_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN ? ELSE (SELECT root_session_id FROM sessions WHERE id = ?) END, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.title,
        repository.repoOwner,
        repository.repoName,
        session.model,
        session.reasoningEffort,
        repository.baseBranch,
        session.status,
        session.parentSessionId ?? null,
        session.parentSessionId ?? null,
        session.id,
        session.parentSessionId ?? null,
        session.spawnSource ?? "user",
        session.spawnDepth ?? 0,
        session.automationId ?? null,
        session.automationRunId ?? null,
        session.scmLogin ?? null,
        session.userId ?? null,
        session.environmentId ?? null,
        session.createdAt,
        session.updatedAt
      );

    const repositoryStmts = (session.repositories ?? []).map((repo, position) =>
      this.db
        .prepare(
          `INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, repo_id, base_branch)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          session.id,
          position,
          normalizeRepoIdentifier(repo.repoOwner),
          normalizeRepoIdentifier(repo.repoName),
          repo.repoId,
          repo.baseBranch
        )
    );

    const manifestStmts = session.skillManifest
      ? this.bindManifestInserts(session.id, session.skillManifest)
      : session.skillManifestSourceSessionId
        ? this.bindManifestCopy(session.id, session.skillManifestSourceSessionId)
        : [];
    const providerAuthStmts = (session.providerAuth ?? []).map((auth) =>
      this.db
        .prepare(
          `INSERT OR REPLACE INTO session_model_provider_auth (
             session_id, provider, auth_mode, provider_account_id, selection_source,
             inherited_from_session_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          session.id,
          auth.provider,
          auth.authMode,
          "providerAccountId" in auth ? auth.providerAccountId : null,
          auth.selectionSource,
          auth.inheritedFromSessionId ?? null,
          session.createdAt
        )
    );
    const results = await this.db.batch([
      sessionStmt,
      ...repositoryStmts,
      ...manifestStmts,
      ...providerAuthStmts,
    ]);

    // Session ids are always freshly generated, so a skipped insert is a bug;
    // initialize.ts relies on D1 failures being caught before sandbox spawn.
    if ((results[0]?.meta?.changes ?? 0) === 0) {
      throw new Error(
        `Session index insert was skipped for session ${session.id} (duplicate id or constraint violation)`
      );
    }
  }

  /**
   * Build manifest statements for the session-creation batch. The caller owns
   * execution so the session, repository snapshot, and pinned skills commit
   * atomically rather than leaving a partially initialized session.
   *
   * Revisions are packed into multi-row INSERTs: the pinned set is as wide as
   * the applicable catalog, and a statement per skill would spend the
   * invocation's whole query budget on one session create.
   */
  private bindManifestInserts(
    sessionId: string,
    manifest: SessionSkillManifestInput
  ): SqlStatement[] {
    const profile = manifest.selection.mode === "profile" ? manifest.selection : null;
    return [
      this.db
        .prepare(
          `INSERT INTO session_skill_manifests
           (session_id, selection_mode, profile_id, profile_name, resolver_version, manifest_sha256, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          sessionId,
          manifest.selection.mode,
          profile?.profileId ?? null,
          profile?.profileName ?? null,
          manifest.resolverVersion,
          manifest.manifestSha256,
          manifest.resolvedAt
        ),
      ...bulkInsertStatements(
        this.db,
        "session_skill_revisions",
        manifest.skills.map((skill, position) => ({
          session_id: sessionId,
          position,
          skill_id: skill.skillId,
          revision_id: skill.revisionId,
          skill_name: skill.name,
          description: skill.description,
          revision_number: skill.revisionNumber,
          revision_sha256: skill.revisionSha256,
          total_bytes: skill.totalBytes,
          assignment_sources: JSON.stringify(skill.assignmentSources),
        }))
      ),
    ];
  }

  /** Copy a parent's exact pinned manifest into the atomic child-session batch. */
  private bindManifestCopy(childSessionId: string, parentSessionId: string): SqlStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO session_skill_manifests
           (session_id, selection_mode, profile_id, profile_name, manifest_sha256, resolved_at,
              resolver_version)
             SELECT ?, selection_mode, profile_id, profile_name, manifest_sha256, resolved_at,
                    resolver_version
           FROM session_skill_manifests WHERE session_id = ?`
        )
        .bind(childSessionId, parentSessionId),
      this.db
        .prepare(
          `INSERT INTO session_skill_revisions
           (session_id, position, skill_id, revision_id, skill_name, description,
            revision_number, revision_sha256, total_bytes, assignment_sources)
           SELECT ?, position, skill_id, revision_id, skill_name, description,
                   revision_number, revision_sha256, total_bytes, assignment_sources
           FROM session_skill_revisions WHERE session_id = ? ORDER BY position`
        )
        .bind(childSessionId, parentSessionId),
    ];
  }

  async get(id: string): Promise<SessionEntry | null> {
    const result = await this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(id)
      .first<SessionRow>();

    return result ? toEntry(result) : null;
  }

  private async getProviderAuth(sessionId: string): Promise<SessionModelProviderAuthInput[]> {
    const result = await this.db
      .prepare(
        `SELECT provider, auth_mode, provider_account_id, selection_source,
                inherited_from_session_id
         FROM session_model_provider_auth
         WHERE session_id = ? ORDER BY provider`
      )
      .bind(sessionId)
      .all<SessionModelProviderAuthRow>();
    return (result.results ?? []).map(toProviderAuth);
  }

  async getCompleteProviderAuth(sessionId: string): Promise<SessionModelProviderAuthInput[]> {
    const providerAuth = await this.getProviderAuth(sessionId);
    if (!isCompleteProviderAuth(providerAuth)) {
      throw new Error(`Session provider auth snapshot is incomplete for session ${sessionId}`);
    }
    return providerAuth;
  }

  async getProviderAuthForProvider(
    sessionId: string,
    provider: ModelProviderId
  ): Promise<SessionModelProviderAuthInput | null> {
    const row = await this.db
      .prepare(
        `SELECT provider, auth_mode, provider_account_id, selection_source,
                inherited_from_session_id
         FROM session_model_provider_auth
         WHERE session_id = ? AND provider = ?`
      )
      .bind(sessionId, provider)
      .first<SessionModelProviderAuthRow>();
    return row ? toProviderAuth(row) : null;
  }

  /**
   * Whether the session exists and the repository is in its repository set
   * (the scalar primary mirror or a session_repositories row). This is the
   * webhook branch-fallback gate (design §5.2): a branch-derived insert may
   * only attach to a session already associated with the event's repository.
   * Case-insensitive — provider repo identifiers are case-insensitive while
   * stored casing is display-canonical.
   */
  async isRepositoryAssociated(
    sessionId: string,
    repoOwner: string,
    repoName: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ok FROM sessions
         WHERE id = ?1
           AND (
             (LOWER(repo_owner) = LOWER(?2) AND LOWER(repo_name) = LOWER(?3))
             OR EXISTS (
               SELECT 1 FROM session_repositories sr
               WHERE sr.session_id = sessions.id
                 AND LOWER(sr.repo_owner) = LOWER(?2)
                 AND LOWER(sr.repo_name) = LOWER(?3)
             )
           )`
      )
      .bind(sessionId, repoOwner, repoName)
      .first<{ ok: number }>();

    return row !== null;
  }

  /** List sessions with optional viewer-specific read state. */
  async list(options: ListSessionsOptions = {}): Promise<ListSessionsResult> {
    const {
      status,
      excludeStatus,
      excludeAutomationLineage,
      createdByUserIds,
      limit = DEFAULT_SESSION_LIST_LIMIT,
      offset = DEFAULT_SESSION_LIST_OFFSET,
      viewerUserId,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }

    if (excludeStatus) {
      conditions.push("status != ?");
      params.push(excludeStatus);
    }

    if (excludeAutomationLineage) {
      // The "Mine" view excludes sessions no human initiated in the app.
      // github-bot sessions are attributed to the webhook sender (the verified
      // actor), but auto reviews and review-request handling are bot-initiated,
      // so they are lineage-excluded alongside automation runs.
      conditions.push("automation_id IS NULL AND spawn_source NOT IN ('automation', 'github-bot')");
    }

    if (createdByUserIds?.length) {
      conditions.push(`user_id IN (${createdByUserIds.map(() => "?").join(", ")})`);
      params.push(...createdByUserIds);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const pageSql = `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const pageParams = [...params, limit + 1, offset];
    const result = viewerUserId
      ? await this.db
          .prepare(
            `WITH paged_sessions AS (${pageSql})
             SELECT paged_sessions.*,
                    ${unreadSql("paged_sessions")} AS unread
             FROM paged_sessions
             LEFT JOIN users viewer ON viewer.id = ?
             LEFT JOIN session_read_states read_state
               ON read_state.session_id = paged_sessions.id
              AND read_state.user_id = viewer.id
             ORDER BY paged_sessions.updated_at DESC`
          )
          .bind(...pageParams, viewerUserId)
          .all<ViewerSessionRow>()
      : await this.db
          .prepare(pageSql)
          .bind(...pageParams)
          .all<SessionRow>();

    const rows = result.results || [];
    const sessions = await this.attachListMetadata(
      rows.slice(0, limit).map((row) => ({
        ...toEntry(row),
        ...(viewerUserId ? { readState: readStateFromRow(row as ViewerSessionRow) } : {}),
      }))
    );

    return {
      sessions,
      hasMore: rows.length > limit,
    };
  }

  /** List one inbox category with viewer-specific read state. */
  async listInbox(options: ListSessionInboxOptions): Promise<ListSessionInboxResult> {
    return new SessionInboxStore(this.db).list(options);
  }

  /** List the first page of every inbox category with viewer-specific read state. */
  async listInboxSnapshot(
    options: Omit<ListSessionInboxOptions, "category" | "cursor">
  ): Promise<ListSessionInboxSnapshotResult> {
    return new SessionInboxStore(this.db).snapshot(options);
  }

  private async attachListMetadata<T extends { id: string }>(sessions: T[]): Promise<T[]> {
    return attachSessionListMetadata(this.db, sessions);
  }

  async recordLatestTerminalMessage(input: {
    sessionId: string;
    messageId: string;
    messageCreatedAt: number;
    terminalMessageCompletedAt: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
         SET latest_terminal_message_id = ?,
             latest_terminal_message_created_at = ?,
             latest_terminal_message_completed_at = ?
         WHERE id = ?
           AND (
             latest_terminal_message_created_at IS NULL
             OR latest_terminal_message_created_at < ?
             OR (
               latest_terminal_message_created_at = ?
               AND latest_terminal_message_id < ?
             )
           )`
      )
      .bind(
        input.messageId,
        input.messageCreatedAt,
        input.terminalMessageCompletedAt,
        input.sessionId,
        input.messageCreatedAt,
        input.messageCreatedAt,
        input.messageId
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async updateReadState(
    userId: string,
    sessionId: string,
    action: SessionReadAction
  ): Promise<SessionReadResult | null> {
    let writeApplied: boolean;
    if (action.action === "mark_message_read") {
      const result = await this.db
        .prepare(
          `INSERT INTO session_read_states
             (user_id, session_id, last_read_message_id, updated_at)
           SELECT ?, id, latest_terminal_message_id, ?
           FROM sessions
           WHERE id = ? AND latest_terminal_message_id = ?
           ON CONFLICT(user_id, session_id) DO UPDATE SET
              last_read_message_id = excluded.last_read_message_id,
              updated_at = excluded.updated_at
            WHERE session_read_states.last_read_message_id
              != excluded.last_read_message_id`
        )
        .bind(userId, Date.now(), sessionId, action.messageId)
        .run();
      writeApplied = (result.meta.changes ?? 0) > 0;
    } else {
      const result = await this.db
        .prepare(
          `INSERT INTO session_read_states
             (user_id, session_id, last_read_message_id, updated_at)
           SELECT ?, id, latest_terminal_message_id, ?
           FROM sessions
           WHERE id = ? AND latest_terminal_message_id IS NOT NULL
           ON CONFLICT(user_id, session_id) DO UPDATE SET
              last_read_message_id = excluded.last_read_message_id,
              updated_at = excluded.updated_at
            WHERE session_read_states.last_read_message_id
              != excluded.last_read_message_id`
        )
        .bind(userId, Date.now(), sessionId)
        .run();
      writeApplied = (result.meta.changes ?? 0) > 0;
    }

    const currentReadState = await this.readStateForSession(userId, sessionId);
    if (!currentReadState) return null;
    const latestMessageId = currentReadState.latestMessageId;
    if (latestMessageId === null) {
      return {
        sessionId,
        outcome: "no_terminal_message",
        unread: false,
        latestMessageId: null,
        version: currentReadState.version,
      };
    }
    const outcome =
      action.action === "mark_message_read" && latestMessageId !== action.messageId
        ? "not_latest"
        : writeApplied
          ? "marked_read"
          : "already_read";
    return {
      sessionId,
      outcome,
      unread: currentReadState.unread,
      latestMessageId,
      version: currentReadState.version,
    };
  }

  private async readStateForSession(
    userId: string,
    sessionId: string
  ): Promise<SessionReadState | null> {
    const row = await this.db
      .prepare(
        `SELECT sessions.latest_terminal_message_id,
                sessions.latest_terminal_message_created_at,
                ${unreadSql("sessions")} AS unread
         FROM sessions
         LEFT JOIN users viewer ON viewer.id = ?
         LEFT JOIN session_read_states read_state
           ON read_state.session_id = sessions.id
          AND read_state.user_id = viewer.id
         WHERE sessions.id = ?`
      )
      .bind(userId, sessionId)
      .first<ViewerReadStateRow>();
    return row ? readStateFromRow(row) : null;
  }

  async updateTitle(id: string, title: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .bind(title, Date.now(), id)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async updateTitleIfNewer(id: string, title: string, updatedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(title, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updateStatus(id: string, status: SessionStatus, updatedAt = Date.now()): Promise<boolean> {
    // Protect against out-of-order async writes by only applying monotonic updated_at values.
    const result = await this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ? AND updated_at <= ?")
      .bind(status, updatedAt, id, updatedAt)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async updateMetrics(
    id: string,
    metrics: {
      totalCost: number;
      activeDurationMs: number;
      messageCount: number;
      prCount: number;
    }
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET total_cost = ?, active_duration_ms = ?, message_count = ?, pr_count = ?
         WHERE id = ?`
      )
      .bind(metrics.totalCost, metrics.activeDurationMs, metrics.messageCount, metrics.prCount, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Warm sessions that never received a prompt, untouched since `staleBefore`.
   *
   * `created` is the status a session holds until its first prompt is enqueued,
   * so a row still sitting there long after its last update was abandoned before
   * any work started. Ordered oldest-first, which drains a backlog only while
   * every visited row leaves this set — see `archiveOrphanedDraft` and
   * `repairStatus` for the two cases where that had to be made true.
   */
  async listAbandonedDraftSessionIds(staleBefore: number, limit: number): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT id FROM sessions
         WHERE status = 'created' AND updated_at < ?
         ORDER BY updated_at ASC
         LIMIT ?`
      )
      .bind(staleBefore, limit)
      .all<{ id: string }>();

    return (result.results ?? []).map((row) => row.id);
  }

  /**
   * Retire an index row whose Durable Object holds no session at all.
   *
   * A 404 from the expiry route is definitive rather than transient: there is no
   * Durable Object state for this row to diverge from, so the index can be
   * corrected on its own. Guarded on `created` so a row that acquired a real
   * session between the sweep's read and this write is left alone.
   */
  async archiveOrphanedDraft(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'created'"
      )
      .bind(Date.now(), id)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Correct a draft status projection that drifted away from its Durable Object.
   *
   * Deliberately not `updateStatus`, which carries an `updated_at` and refuses
   * writes that would move it backwards. That guard keeps concurrent transitions
   * ordered, but it silently drops a repair: the Durable Object sends its own
   * timestamp, which is behind D1's whenever `touchUpdatedAt` has run, so the
   * write matches no rows and reports success as `false`. This repair asserts
   * only the stale shape the draft sweep selected: D1 still says `created`, and
   * the Durable Object says otherwise. Only that status column is written,
   * leaving `updated_at` to keep meaning "last real activity".
   */
  async repairStatus(id: string, status: SessionStatus): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET status = ? WHERE id = ? AND status = 'created' AND status != ?")
      .bind(status, id, status)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async touchUpdatedAt(id: string): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async delete(id: string): Promise<boolean> {
    // Member rows are removed explicitly for clarity; the FK's ON DELETE
    // CASCADE also covers callers that delete the session row directly.
    const [, result] = await this.db.batch([
      this.db.prepare("DELETE FROM session_repositories WHERE session_id = ?").bind(id),
      this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    ]);

    return (result.meta?.changes ?? 0) > 0;
  }

  /** List children of a parent session, newest first. */
  async listByParent(parentSessionId: string): Promise<SessionEntry[]> {
    const result = await this.db
      .prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at DESC`)
      .bind(parentSessionId)
      .all<SessionRow>();
    return this.attachListMetadata((result.results || []).map(toEntry));
  }

  /** List non-terminal descendants, deepest first, so cancellation cascades bottom-up. */
  async listActiveDescendantIds(parentSessionId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        `WITH RECURSIVE descendants(id, status, depth) AS (
           SELECT id, status, 1 FROM sessions WHERE parent_session_id = ?
           UNION ALL
           SELECT sessions.id, sessions.status, descendants.depth + 1
           FROM sessions
           JOIN descendants ON sessions.parent_session_id = descendants.id
           WHERE descendants.depth < ${MAX_DESCENDANT_DEPTH}
         )
         SELECT id FROM descendants
         WHERE status NOT IN (${INACTIVE_SESSION_STATUS_SQL})
         ORDER BY depth DESC`
      )
      .bind(parentSessionId)
      .all<{ id: string }>();
    return (result.results || []).map(({ id }) => id);
  }

  /** Atomically claim parent concurrency capacity for a child spawn or resume. */
  async acquireChildAdmissionLease(
    parentSessionId: string,
    childSessionId: string,
    maxConcurrentChildren: number
  ): Promise<ChildAdmissionLease | null> {
    const now = Date.now();
    const lease: ChildAdmissionLease = {
      token: crypto.randomUUID(),
      childSessionId,
      expiresAt: now + CHILD_ADMISSION_LEASE_TTL_MS,
    };
    await this.db
      .prepare("DELETE FROM child_admission_leases WHERE expires_at <= ?")
      .bind(now)
      .run();
    const inserted = await this.db
      .prepare(
        `INSERT INTO child_admission_leases
           (lease_token, parent_session_id, child_session_id, expires_at)
         SELECT ?, ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM (
             SELECT id AS child_session_id FROM sessions
             WHERE parent_session_id = ? AND status NOT IN (${INACTIVE_SESSION_STATUS_SQL})
             UNION
             SELECT child_session_id FROM child_admission_leases
             WHERE parent_session_id = ? AND expires_at > ?
           ) admitted_children
         ) < ?
         ON CONFLICT(child_session_id) DO UPDATE SET
           lease_token = excluded.lease_token,
           parent_session_id = excluded.parent_session_id,
           expires_at = excluded.expires_at
         WHERE child_admission_leases.expires_at <= ?`
      )
      .bind(
        lease.token,
        parentSessionId,
        childSessionId,
        lease.expiresAt,
        parentSessionId,
        parentSessionId,
        now,
        maxConcurrentChildren,
        now
      )
      .run();
    return (inserted.meta?.changes ?? 0) > 0 ? lease : null;
  }

  /** Release only the lease owned by this caller. */
  async releaseChildAdmissionLease(lease: ChildAdmissionLease): Promise<void> {
    await this.db
      .prepare("DELETE FROM child_admission_leases WHERE child_session_id = ? AND lease_token = ?")
      .bind(lease.childSessionId, lease.token)
      .run();
  }

  /** Finalize capacity after the child-owned active projection succeeds. */
  async finalizeChildAdmission(childSessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM child_admission_leases WHERE child_session_id = ?")
      .bind(childSessionId)
      .run();
  }

  /** Count total children ever spawned for rate-limit enforcement. */
  async countTotalChildren(parentSessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM sessions WHERE parent_session_id = ?`)
      .bind(parentSessionId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  /** Validate that childId is a direct child of parentId. */
  async isChildOf(childId: string, parentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`SELECT 1 FROM sessions WHERE id = ? AND parent_session_id = ?`)
      .bind(childId, parentId)
      .first();
    return result !== null;
  }

  /** Get a session's stored spawn_depth (single read, no chain walking). */
  async getSpawnDepth(sessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`SELECT spawn_depth FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ spawn_depth: number }>();
    return result?.spawn_depth ?? 0;
  }
}
