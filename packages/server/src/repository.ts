/**
 * Repository layer — all SQL queries for sessions, messages, events, artifacts.
 *
 * Adapted from the original control-plane SessionRepository which used
 * Cloudflare's SqlStorage interface. Now uses better-sqlite3 directly.
 */

import type Database from "better-sqlite3";
import type {
  SessionStatus,
  SandboxStatus,
  MessageStatus,
  ArtifactType,
  SandboxEvent,
} from "@background-agents/shared";

// ─── Row types ──────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  title: string | null;
  repo_path: string;
  repo_name: string;
  base_branch: string;
  branch_name: string | null;
  model: string;
  reasoning_effort: string | null;
  status: SessionStatus;
  sandbox_status: SandboxStatus;
  container_id: string | null;
  worktree_path: string | null;
  opencode_session_id: string | null;
  last_heartbeat: number | null;
  last_activity: number | null;
  spawn_failure_count: number;
  last_spawn_failure: number | null;
  last_spawn_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  content: string;
  source: string;
  model: string | null;
  reasoning_effort: string | null;
  attachments: string | null;
  status: MessageStatus;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface EventRow {
  id: string;
  session_id: string;
  type: string;
  data: string; // JSON
  message_id: string | null;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  type: ArtifactType;
  url: string | null;
  metadata: string | null;
  created_at: number;
}

// ─── Repository class ───────────────────────────────────────────────────────

export class Repository {
  constructor(private readonly db: Database.Database) {}

  // ── Sessions ────────────────────────────────────────────────────────────

  createSession(data: {
    id: string;
    title: string | null;
    repoPath: string;
    repoName: string;
    baseBranch: string;
    model: string;
    reasoningEffort?: string | null;
  }): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, repo_path, repo_name, base_branch, model, reasoning_effort, status, sandbox_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 'pending', ?, ?)`
      )
      .run(
        data.id,
        data.title,
        data.repoPath,
        data.repoName,
        data.baseBranch,
        data.model,
        data.reasoningEffort ?? null,
        now,
        now
      );
    return this.getSession(data.id)!;
  }

  getSession(id: string): SessionRow | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow) ?? null;
  }

  listSessions(options?: { status?: string; limit?: number; cursor?: string }): {
    sessions: SessionRow[];
    hasMore: boolean;
  } {
    const limit = options?.limit ?? 50;
    let query = `SELECT * FROM sessions WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options?.status && options.status !== "all") {
      if (options.status === "active") {
        query += ` AND status != 'archived'`;
      } else {
        query += ` AND status = ?`;
        params.push(options.status);
      }
    }

    if (options?.cursor) {
      query += ` AND updated_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(query).all(...params) as SessionRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { sessions: rows, hasMore };
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  updateSessionSandboxStatus(id: string, status: SandboxStatus): void {
    this.db
      .prepare(`UPDATE sessions SET sandbox_status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  updateSessionContainer(
    id: string,
    containerId: string | null,
    worktreePath: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET container_id = ?, worktree_path = ?, updated_at = ? WHERE id = ?`
      )
      .run(containerId, worktreePath, Date.now(), id);
  }

  updateSessionBranch(id: string, branchName: string): void {
    this.db
      .prepare(`UPDATE sessions SET branch_name = ?, updated_at = ? WHERE id = ?`)
      .run(branchName, Date.now(), id);
  }

  updateSessionModel(id: string, model: string): void {
    this.db
      .prepare(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`)
      .run(model, Date.now(), id);
  }

  updateSessionHeartbeat(id: string, timestamp: number): void {
    this.db.prepare(`UPDATE sessions SET last_heartbeat = ? WHERE id = ?`).run(timestamp, id);
  }

  updateSessionLastActivity(id: string, timestamp: number): void {
    this.db.prepare(`UPDATE sessions SET last_activity = ? WHERE id = ?`).run(timestamp, id);
  }

  updateSessionOpencodeId(id: string, opencodeSessionId: string): void {
    this.db
      .prepare(`UPDATE sessions SET opencode_session_id = ? WHERE id = ?`)
      .run(opencodeSessionId, id);
  }

  incrementSpawnFailure(id: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET spawn_failure_count = spawn_failure_count + 1, last_spawn_failure = ? WHERE id = ?`
      )
      .run(Date.now(), id);
  }

  resetSpawnFailures(id: string): void {
    this.db.prepare(`UPDATE sessions SET spawn_failure_count = 0 WHERE id = ?`).run(id);
  }

  updateSessionSpawnError(id: string, error: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET last_spawn_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, Date.now(), id);
  }

  deleteSession(id: string): void {
    // Cascade delete events, messages, artifacts
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM artifacts WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ── Messages ────────────────────────────────────────────────────────────

  createMessage(data: {
    id: string;
    sessionId: string;
    content: string;
    source?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    attachments?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, content, source, model, reasoning_effort, attachments, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        data.id,
        data.sessionId,
        data.content,
        data.source ?? "web",
        data.model ?? null,
        data.reasoningEffort ?? null,
        data.attachments ?? null,
        Date.now()
      );
  }

  getNextPendingMessage(sessionId: string): MessageRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM messages WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`
        )
        .get(sessionId) as MessageRow) ?? null
    );
  }

  getProcessingMessage(sessionId: string): MessageRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM messages WHERE session_id = ? AND status = 'processing' LIMIT 1`)
        .get(sessionId) as MessageRow) ?? null
    );
  }

  updateMessageToProcessing(messageId: string): void {
    this.db
      .prepare(`UPDATE messages SET status = 'processing', started_at = ? WHERE id = ?`)
      .run(Date.now(), messageId);
  }

  updateMessageCompletion(messageId: string, status: MessageStatus): void {
    this.db
      .prepare(`UPDATE messages SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, Date.now(), messageId);
  }

  getMessageCount(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM messages WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    return row.count;
  }

  listMessages(
    sessionId: string,
    options?: { limit?: number; cursor?: string }
  ): { messages: MessageRow[]; hasMore: boolean } {
    const limit = options?.limit ?? 50;
    let query = `SELECT * FROM messages WHERE session_id = ?`;
    const params: (string | number)[] = [sessionId];

    if (options?.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(query).all(...params) as MessageRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { messages: rows, hasMore };
  }

  // ── Events ──────────────────────────────────────────────────────────────

  createEvent(data: {
    id: string;
    sessionId: string;
    type: string;
    dataJson: string;
    messageId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, type, data, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(data.id, data.sessionId, data.type, data.dataJson, data.messageId, Date.now());
  }

  upsertEvent(data: {
    id: string;
    sessionId: string;
    type: string;
    dataJson: string;
    messageId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, type, data, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         message_id = excluded.message_id,
         created_at = excluded.created_at`
      )
      .run(data.id, data.sessionId, data.type, data.dataJson, data.messageId, Date.now());
  }

  getEventsForReplay(sessionId: string, limit: number = 500): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM events
          WHERE session_id = ? AND type != 'heartbeat'
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId, limit) as EventRow[];
  }

  getEventsHistoryPage(
    sessionId: string,
    cursorTimestamp: number,
    cursorId: string,
    limit: number
  ): { events: EventRow[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
       WHERE session_id = ? AND type != 'heartbeat'
         AND ((created_at < ?) OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(sessionId, cursorTimestamp, cursorTimestamp, cursorId, limit + 1) as EventRow[];

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    rows.reverse();

    return { events: rows, hasMore };
  }

  listEvents(
    sessionId: string,
    options?: { type?: string; messageId?: string; limit?: number; cursor?: string }
  ): { events: EventRow[]; hasMore: boolean } {
    const limit = options?.limit ?? 100;
    let query = `SELECT * FROM events WHERE session_id = ?`;
    const params: (string | number)[] = [sessionId];

    if (options?.type) {
      query += ` AND type = ?`;
      params.push(options.type);
    }
    if (options?.messageId) {
      query += ` AND message_id = ?`;
      params.push(options.messageId);
    }
    if (options?.cursor) {
      query += ` AND created_at < ?`;
      params.push(parseInt(options.cursor));
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(query).all(...params) as EventRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return { events: rows, hasMore };
  }

  // ── Artifacts ───────────────────────────────────────────────────────────

  createArtifact(data: {
    id: string;
    sessionId: string;
    type: ArtifactType;
    url: string | null;
    metadata: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, type, url, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(data.id, data.sessionId, data.type, data.url, data.metadata, Date.now());
  }

  updateArtifact(id: string, data: { url?: string | null; metadata?: string | null }): void {
    if (data.url !== undefined) {
      this.db.prepare(`UPDATE artifacts SET url = ? WHERE id = ?`).run(data.url, id);
    }
    if (data.metadata !== undefined) {
      this.db.prepare(`UPDATE artifacts SET metadata = ? WHERE id = ?`).run(data.metadata, id);
    }
  }

  listArtifacts(sessionId: string): ArtifactRow[] {
    return this.db
      .prepare(`SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as ArtifactRow[];
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }
}
