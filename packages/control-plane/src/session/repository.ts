/**
 * SessionRepository - Database operations for Session Durable Objects.
 *
 * Consolidates all SQL operations from SessionDO into a single class
 * to enable unit testing via mock injection and reduce coupling.
 */

import type {
  SessionRow,
  ParticipantRow,
  MessageRow,
  EventRow,
  ArtifactRow,
  SandboxRow,
} from "./types";
import type {
  SessionStatus,
  SandboxStatus,
  GitSyncStatus,
  MessageStatus,
  MessageSource,
  ParticipantRole,
  ArtifactType,
  SandboxEvent,
} from "../types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;
type UpsertableEventType = TokenEvent["type"] | ExecutionCompleteEvent["type"];

/**
 * WS client mapping result for hibernation recovery.
 */
export interface WsClientMappingResult {
  participant_id: string;
  client_id: string;
  user_id: string;
  scm_name: string | null;
  scm_login: string | null;
}

/**
 * Minimal sandbox state for circuit breaker checks.
 * Only includes fields needed for spawn decisions.
 */
export interface SandboxCircuitBreakerState {
  status: string;
  created_at: number;
  snapshot_image_id: string | null;
  spawn_failure_count: number | null;
  last_spawn_failure: number | null;
}

/**
 * Data for upserting a session.
 */
export interface UpsertSessionData {
  id: string;
  sessionName: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  repoId?: number | null;
  baseBranch?: string;
  model: string;
  reasoningEffort?: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * Data for creating a sandbox.
 */
export interface CreateSandboxData {
  id: string;
  status: SandboxStatus;
  gitSyncStatus: GitSyncStatus;
  createdAt: number;
}

/**
 * Data for creating a participant.
 */
export interface CreateParticipantData {
  id: string;
  userId: string;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmAccessTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  role: ParticipantRole;
  joinedAt: number;
}

/**
 * Data for updating a participant with COALESCE (only non-null values update).
 */
export interface UpdateParticipantData {
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmAccessTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
}

/**
 * Data for creating a message.
 */
export interface CreateMessageData {
  id: string;
  authorId: string;
  content: string;
  source: MessageSource;
  model?: string | null;
  reasoningEffort?: string | null;
  attachments?: string | null;
  callbackContext?: string | null;
  status: MessageStatus;
  createdAt: number;
}

/**
 * Data for creating an event.
 * Note: type is string because sandbox sends additional event types
 * beyond those defined in EventType (e.g., 'heartbeat', 'execution_complete').
 */
export interface CreateEventData {
  id: string;
  type: string;
  data: string;
  messageId: string | null;
  createdAt: number;
}

/**
 * Options for listing events.
 */
export interface ListEventsOptions {
  cursor?: string | null;
  limit: number;
  type?: string | null;
  messageId?: string | null;
}

/**
 * Options for listing messages.
 */
export interface ListMessagesOptions {
  cursor?: string | null;
  limit: number;
  status?: string | null;
}

/**
 * Data for creating an artifact.
 */
export interface CreateArtifactData {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: string | null;
  createdAt: number;
}

/**
 * Data for WS client mapping.
 */
export interface WsClientMappingData {
  wsId: string;
  participantId: string;
  clientId: string;
  createdAt: number;
}

/**
 * Data for spawn sandbox update.
 */
export interface SpawnSandboxData {
  status: SandboxStatus;
  createdAt: number;
  authTokenHash: string;
  modalSandboxId: string;
}

/**
 * SqlStorage interface matching Cloudflare's SqlStorage.
 * Used to allow mock injection for testing.
 */
export interface SqlStorage {
  exec(query: string, ...params: unknown[]): SqlResult;
}

export interface SqlResult {
  toArray(): unknown[];
  one(): unknown;
}

/**
 * SessionRepository encapsulates all database operations for a session.
 */
export class SessionRepository {
  constructor(private readonly sql: SqlStorage) {}

  // === SESSION ===

  getSession(): SessionRow | null {
    const result = this.sql.exec(`SELECT * FROM session LIMIT 1`);
    const rows = result.toArray() as unknown as SessionRow[];
    return rows[0] ?? null;
  }

  upsertSession(data: UpsertSessionData): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO session (id, session_name, title, repo_owner, repo_name, repo_id, base_branch, model, reasoning_effort, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.sessionName,
      data.title,
      data.repoOwner,
      data.repoName,
      data.repoId ?? null,
      data.baseBranch ?? "main",
      data.model,
      data.reasoningEffort ?? null,
      data.status,
      data.createdAt,
      data.updatedAt
    );
  }

  updateSessionRepoId(repoId: number): void {
    this.sql.exec(
      `UPDATE session SET repo_id = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
      repoId
    );
  }

  updateSessionBranch(sessionId: string, branchName: string): void {
    this.sql.exec(`UPDATE session SET branch_name = ? WHERE id = ?`, branchName, sessionId);
  }

  updateSessionCurrentSha(sha: string): void {
    // Each session DO has exactly one session row
    this.sql.exec(
      `UPDATE session SET current_sha = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
      sha
    );
  }

  updateSessionStatus(sessionId: string, status: SessionStatus, updatedAt: number): void {
    this.sql.exec(
      `UPDATE session SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      updatedAt,
      sessionId
    );
  }

  // === SANDBOX ===
  // Note: Each session DO has exactly one sandbox row, so update methods use
  // a subquery `WHERE id = (SELECT id FROM sandbox LIMIT 1)` to find it.

  getSandbox(): SandboxRow | null {
    const result = this.sql.exec(`SELECT * FROM sandbox LIMIT 1`);
    const rows = result.toArray() as unknown as SandboxRow[];
    return rows[0] ?? null;
  }

  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerState | null {
    const result = this.sql.exec(
      `SELECT status, created_at, snapshot_image_id, spawn_failure_count, last_spawn_failure FROM sandbox LIMIT 1`
    );
    const rows = result.toArray() as unknown as SandboxCircuitBreakerState[];
    return rows[0] ?? null;
  }

  createSandbox(data: CreateSandboxData): void {
    this.sql.exec(
      `INSERT INTO sandbox (id, status, git_sync_status, created_at)
       VALUES (?, ?, ?, ?)`,
      data.id,
      data.status,
      data.gitSyncStatus,
      data.createdAt
    );
  }

  updateSandboxStatus(status: SandboxStatus): void {
    this.sql.exec(
      `UPDATE sandbox SET status = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      status
    );
  }

  updateSandboxForSpawn(data: SpawnSandboxData): void {
    this.sql.exec(
      `UPDATE sandbox SET
         status = ?,
         created_at = ?,
         auth_token_hash = ?,
         auth_token = NULL,
         modal_sandbox_id = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      data.status,
      data.createdAt,
      data.authTokenHash,
      data.modalSandboxId
    );
  }

  updateSandboxModalObjectId(modalObjectId: string): void {
    this.sql.exec(
      `UPDATE sandbox SET modal_object_id = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      modalObjectId
    );
  }

  updateSandboxSnapshotImageId(sandboxId: string, imageId: string): void {
    this.sql.exec(`UPDATE sandbox SET snapshot_image_id = ? WHERE id = ?`, imageId, sandboxId);
  }

  updateSandboxHeartbeat(timestamp: number): void {
    this.sql.exec(
      `UPDATE sandbox SET last_heartbeat = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      timestamp
    );
  }

  updateSandboxLastActivity(timestamp: number): void {
    this.sql.exec(
      `UPDATE sandbox SET last_activity = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      timestamp
    );
  }

  updateSandboxGitSyncStatus(status: GitSyncStatus): void {
    this.sql.exec(
      `UPDATE sandbox SET git_sync_status = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      status
    );
  }

  updateSandboxSpawnError(error: string | null, timestamp: number | null): void {
    this.sql.exec(
      `UPDATE sandbox SET last_spawn_error = ?, last_spawn_error_at = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      error,
      timestamp
    );
  }

  resetCircuitBreaker(): void {
    this.sql.exec(
      `UPDATE sandbox SET spawn_failure_count = 0 WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  incrementCircuitBreakerFailure(timestamp: number): void {
    this.sql.exec(
      `UPDATE sandbox SET
         spawn_failure_count = COALESCE(spawn_failure_count, 0) + 1,
         last_spawn_failure = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      timestamp
    );
  }

  // === PARTICIPANTS ===

  getParticipantByUserId(userId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE user_id = ?`, userId);
    const rows = result.toArray() as unknown as ParticipantRow[];
    return rows[0] ?? null;
  }

  getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE ws_auth_token = ?`, tokenHash);
    const rows = result.toArray() as unknown as ParticipantRow[];
    return rows[0] ?? null;
  }

  getParticipantById(participantId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE id = ?`, participantId);
    const rows = result.toArray() as unknown as ParticipantRow[];
    return rows[0] ?? null;
  }

  createParticipant(data: CreateParticipantData): void {
    this.sql.exec(
      `INSERT INTO participants (id, user_id, scm_user_id, scm_login, scm_name, scm_email, scm_access_token_encrypted, scm_refresh_token_encrypted, scm_token_expires_at, role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.userId,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
      data.scmAccessTokenEncrypted ?? null,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt ?? null,
      data.role,
      data.joinedAt
    );
  }

  updateParticipantCoalesce(participantId: string, data: UpdateParticipantData): void {
    this.sql.exec(
      `UPDATE participants SET
         scm_user_id = COALESCE(?, scm_user_id),
         scm_login = COALESCE(?, scm_login),
         scm_name = COALESCE(?, scm_name),
         scm_email = COALESCE(?, scm_email),
         scm_access_token_encrypted = COALESCE(?, scm_access_token_encrypted),
         scm_refresh_token_encrypted = COALESCE(?, scm_refresh_token_encrypted),
         scm_token_expires_at = COALESCE(?, scm_token_expires_at)
       WHERE id = ?`,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
      data.scmAccessTokenEncrypted ?? null,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt ?? null,
      participantId
    );
  }

  updateParticipantTokens(
    participantId: string,
    data: {
      scmAccessTokenEncrypted: string;
      scmRefreshTokenEncrypted?: string | null;
      scmTokenExpiresAt: number;
    }
  ): void {
    this.sql.exec(
      `UPDATE participants SET
         scm_access_token_encrypted = ?,
         scm_refresh_token_encrypted = COALESCE(?, scm_refresh_token_encrypted),
         scm_token_expires_at = ?
       WHERE id = ?`,
      data.scmAccessTokenEncrypted,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt,
      participantId
    );
  }

  updateParticipantWsToken(participantId: string, tokenHash: string, createdAt: number): void {
    this.sql.exec(
      `UPDATE participants SET ws_auth_token = ?, ws_token_created_at = ? WHERE id = ?`,
      tokenHash,
      createdAt,
      participantId
    );
  }

  listParticipants(): ParticipantRow[] {
    const result = this.sql.exec(`SELECT * FROM participants ORDER BY joined_at`);
    return result.toArray() as unknown as ParticipantRow[];
  }

  // === MESSAGES ===

  getMessageCount(): number {
    const result = this.sql.exec(`SELECT COUNT(*) as count FROM messages`);
    return (result.one() as { count: number }).count;
  }

  getPendingOrProcessingCount(): number {
    const result = this.sql.exec(
      `SELECT COUNT(*) as count FROM messages WHERE status IN ('pending', 'processing')`
    );
    return (result.one() as { count: number }).count;
  }

  getProcessingMessage(): { id: string } | null {
    const result = this.sql.exec(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`);
    const rows = result.toArray() as Array<{ id: string }>;
    return rows[0] ?? null;
  }

  getProcessingMessageWithStartedAt(): { id: string; started_at: number } | null {
    const result = this.sql.exec(
      `SELECT id, started_at FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const rows = result.toArray() as Array<{ id: string; started_at: number }>;
    return rows[0] ?? null;
  }

  getNextPendingMessage(): MessageRow | null {
    const result = this.sql.exec(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    );
    const rows = result.toArray() as unknown as MessageRow[];
    return rows[0] ?? null;
  }

  getMessageCallbackContext(
    messageId: string
  ): { callback_context: string | null; source: string | null } | null {
    const result = this.sql.exec(
      `SELECT callback_context, source FROM messages WHERE id = ?`,
      messageId
    );
    const rows = result.toArray() as Array<{
      callback_context: string | null;
      source: string | null;
    }>;
    return rows[0] ?? null;
  }

  createMessage(data: CreateMessageData): void {
    this.sql.exec(
      `INSERT INTO messages (id, author_id, content, source, model, reasoning_effort, attachments, callback_context, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.authorId,
      data.content,
      data.source,
      data.model ?? null,
      data.reasoningEffort ?? null,
      data.attachments ?? null,
      data.callbackContext ?? null,
      data.status,
      data.createdAt
    );
  }

  updateMessageToProcessing(messageId: string, startedAt: number): void {
    this.sql.exec(
      `UPDATE messages SET status = 'processing', started_at = ? WHERE id = ?`,
      startedAt,
      messageId
    );
  }

  updateMessageCompletion(messageId: string, status: MessageStatus, completedAt: number): void {
    this.sql.exec(
      `UPDATE messages SET status = ?, completed_at = ? WHERE id = ?`,
      status,
      completedAt,
      messageId
    );
  }

  getMessageTimestamps(
    messageId: string
  ): { created_at: number; started_at: number | null } | null {
    const result = this.sql.exec(
      `SELECT created_at, started_at FROM messages WHERE id = ?`,
      messageId
    );
    const rows = result.toArray() as Array<{ created_at: number; started_at: number | null }>;
    return rows[0] ?? null;
  }

  listMessages(options: ListMessagesOptions): MessageRow[] {
    // WHERE 1=1 allows appending AND clauses unconditionally
    let query = `SELECT * FROM messages WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options.status) {
      query += ` AND status = ?`;
      params.push(options.status);
    }

    if (options.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(options.limit + 1);

    const result = this.sql.exec(query, ...params);
    return result.toArray() as unknown as MessageRow[];
  }

  // === EVENTS ===

  createEvent(data: CreateEventData): void {
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      data.id,
      data.type,
      data.data,
      data.messageId,
      data.createdAt
    );
  }

  private upsertEventByMessageId<TType extends UpsertableEventType>(
    type: TType,
    messageId: string,
    event: Extract<SandboxEvent, { type: TType }>,
    createdAt: number
  ): void {
    const id = `${type}:${messageId}`;
    this.sql.exec(
      `INSERT INTO events (id, type, data, message_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id,
         created_at = excluded.created_at`,
      id,
      type,
      JSON.stringify(event),
      messageId,
      createdAt
    );
  }

  upsertTokenEvent(messageId: string, event: TokenEvent, createdAt: number): void {
    this.upsertEventByMessageId("token", messageId, event, createdAt);
  }

  upsertExecutionCompleteEvent(
    messageId: string,
    event: ExecutionCompleteEvent,
    createdAt: number
  ): void {
    this.upsertEventByMessageId("execution_complete", messageId, event, createdAt);
  }

  listEvents(options: ListEventsOptions): EventRow[] {
    let query = `SELECT * FROM events WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options.type) {
      query += ` AND type = ?`;
      params.push(options.type);
    }

    if (options.messageId) {
      query += ` AND message_id = ?`;
      params.push(options.messageId);
    }

    if (options.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(options.limit + 1);

    const result = this.sql.exec(query, ...params);
    return result.toArray() as unknown as EventRow[];
  }

  getEventsForReplay(limit: number): EventRow[] {
    const result = this.sql.exec(
      `SELECT * FROM (
         SELECT * FROM events WHERE type != 'heartbeat'
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) sub ORDER BY created_at ASC, id ASC`,
      limit
    );
    return result.toArray() as unknown as EventRow[];
  }

  /**
   * Paginate the events timeline using a composite cursor.
   * Returns events older than the cursor in chronological order, plus a hasMore flag.
   */
  getEventsHistoryPage(
    cursorTimestamp: number,
    cursorId: string,
    limit: number
  ): {
    events: EventRow[];
    hasMore: boolean;
  } {
    const rows = this.sql
      .exec(
        `SELECT * FROM events
         WHERE type != 'heartbeat' AND ((created_at < ?1) OR (created_at = ?1 AND id < ?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`,
        cursorTimestamp,
        cursorId,
        limit + 1
      )
      .toArray() as unknown as EventRow[];

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    rows.reverse(); // chronological order

    return { events: rows, hasMore };
  }

  // === ARTIFACTS ===

  createArtifact(data: CreateArtifactData): void {
    this.sql.exec(
      `INSERT INTO artifacts (id, type, url, metadata, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      data.id,
      data.type,
      data.url,
      data.metadata,
      data.createdAt
    );
  }

  listArtifacts(): ArtifactRow[] {
    const result = this.sql.exec(`SELECT * FROM artifacts ORDER BY created_at DESC`);
    return result.toArray() as unknown as ArtifactRow[];
  }

  // === WS CLIENT MAPPING ===

  upsertWsClientMapping(data: WsClientMappingData): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ws_client_mapping (ws_id, participant_id, client_id, created_at)
       VALUES (?, ?, ?, ?)`,
      data.wsId,
      data.participantId,
      data.clientId,
      data.createdAt
    );
  }

  getWsClientMapping(wsId: string): WsClientMappingResult | null {
    const result = this.sql.exec(
      `SELECT m.participant_id, m.client_id, p.user_id, p.scm_name, p.scm_login
       FROM ws_client_mapping m
       JOIN participants p ON m.participant_id = p.id
       WHERE m.ws_id = ?`,
      wsId
    );
    const rows = result.toArray() as unknown as WsClientMappingResult[];
    return rows[0] ?? null;
  }

  hasWsClientMapping(wsId: string): boolean {
    const result = this.sql.exec(
      `SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`,
      wsId
    );
    return result.toArray().length > 0;
  }

  // === PR HELPERS ===

  getProcessingMessageAuthor(): { author_id: string } | null {
    const result = this.sql.exec(
      `SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`
    );
    const rows = result.toArray() as Array<{ author_id: string }>;
    return rows[0] ?? null;
  }
}
