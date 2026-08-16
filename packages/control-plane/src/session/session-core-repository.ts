import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { buildSessionRepositories, type SessionRepositoryEntry } from "./repository-target";
import type { SqlResult, SqlStorage, TransactionSync } from "./sql-storage";
import type { SessionRepositoryRow, SessionRow } from "./types";

/** Data for upserting a session. */
export interface UpsertSessionData {
  id: string;
  sessionName: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  repoId?: number | null;
  baseBranch?: string | null;
  model: string;
  reasoningEffort?: string | null;
  status: SessionStatus;
  parentSessionId?: string | null;
  spawnSource?: SpawnSource;
  spawnDepth?: number;
  codeServerEnabled?: boolean;
  vncEnabled?: boolean;
  sandboxSettings?: string | null;
  /** Launch environment provenance; null for repo-launched/ad-hoc sessions. */
  environmentId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Data for writing a session's member repository set. Per-repository git state
 * is written separately by push handling.
 */
export interface SessionRepositoryData {
  position: number;
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/** Persistence for the session and its member repositories. */
export class SessionCoreRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  private rows<T>(result: SqlResult): T[] {
    return result.toArray() as T[];
  }

  getSession(): SessionRow | null {
    const result = this.sql.exec(`SELECT * FROM session LIMIT 1`);
    const rows = this.rows<SessionRow>(result);
    return rows[0] ?? null;
  }

  upsertSession(data: UpsertSessionData): void {
    const hasRepoOwner = data.repoOwner !== null;
    const hasRepoName = data.repoName !== null;
    if (hasRepoOwner !== hasRepoName) {
      throw new Error("Session repository context must include repoOwner and repoName together");
    }
    if (!hasRepoOwner && (data.repoId != null || data.baseBranch != null)) {
      throw new Error("No-repository sessions must not persist repoId or baseBranch");
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO session (id, session_name, title, repo_owner, repo_name, repo_id, base_branch, model, reasoning_effort, status, parent_session_id, spawn_source, spawn_depth, code_server_enabled, vnc_enabled, sandbox_settings, environment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.sessionName,
      data.title,
      data.repoOwner,
      data.repoName,
      data.repoId ?? null,
      data.baseBranch ?? (hasRepoOwner ? "main" : null),
      data.model,
      data.reasoningEffort ?? null,
      data.status,
      data.parentSessionId ?? null,
      data.spawnSource ?? "user",
      data.spawnDepth ?? 0,
      data.codeServerEnabled ? 1 : 0,
      data.vncEnabled ? 1 : 0,
      data.sandboxSettings ?? null,
      data.environmentId ?? null,
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
    // Each session DO has exactly one session row.
    this.sql.exec(
      `UPDATE session SET current_sha = ? WHERE id = (SELECT id FROM session LIMIT 1)`,
      sha
    );
  }

  updateSessionTitle(sessionId: string, title: string, updatedAt: number): void {
    this.sql.exec(
      `UPDATE session SET title = ?, updated_at = ? WHERE id = ?`,
      title,
      updatedAt,
      sessionId
    );
  }

  updateSessionTitleIfUnset(sessionId: string, title: string, updatedAt: number): boolean {
    const result = this.sql.exec(
      `UPDATE session SET title = ?, updated_at = ?
       WHERE id = ? AND (title IS NULL OR TRIM(title) = '')`,
      title,
      updatedAt,
      sessionId
    );

    // Consume the result before reading rowsWritten so the count is final.
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  updateSessionStatus(sessionId: string, status: SessionStatus, updatedAt: number): void {
    this.sql.exec(
      `UPDATE session SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      updatedAt,
      sessionId
    );
  }

  addSessionCost(cost: number, updatedAt: number): void {
    this.sql.exec(
      `UPDATE session
       SET total_cost = total_cost + ?, updated_at = ?
       WHERE id = (SELECT id FROM session LIMIT 1)`,
      cost,
      updatedAt
    );
  }

  /**
   * Replace the session's member repository set. Per-repository git state
   * resets with the set because it describes work on the replaced members.
   */
  replaceSessionRepositories(repositories: SessionRepositoryData[]): void {
    this.sql.exec(`DELETE FROM session_repositories`);
    for (const repo of repositories) {
      this.sql.exec(
        `INSERT INTO session_repositories (position, repo_owner, repo_name, repo_id, base_branch)
         VALUES (?, ?, ?, ?, ?)`,
        repo.position,
        repo.repoOwner,
        repo.repoName,
        repo.repoId,
        repo.baseBranch
      );
    }
  }

  getSessionRepositoryRows(): SessionRepositoryRow[] {
    const result = this.sql.exec(`SELECT * FROM session_repositories ORDER BY position`);
    return this.rows<SessionRepositoryRow>(result);
  }

  /**
   * Returns the session's repositories, using the scalar mirror fallback for
   * older sessions. Empty only for sessions without repository context.
   */
  getSessionRepositories(): SessionRepositoryEntry[] {
    const session = this.getSession();
    if (!session?.repo_owner || !session.repo_name) return [];
    return buildSessionRepositories(
      {
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
        baseBranch: session.base_branch,
      },
      this.getSessionRepositoryRows()
    );
  }

  updateSessionRepositoryBranch(repoOwner: string, repoName: string, branchName: string): void {
    this.sql.exec(
      `UPDATE session_repositories SET branch_name = ? WHERE repo_owner = ? AND repo_name = ?`,
      branchName,
      repoOwner,
      repoName
    );
  }

  setSessionDiffBaselines(
    repositories: Array<{
      position: number;
      repoOwner: string;
      repoName: string;
      baseSha: string;
      isPrimary: boolean;
    }>
  ): void {
    this.transactionSync(() => {
      for (const repository of repositories) {
        this.sql.exec(
          `UPDATE session_repositories
           SET base_sha = ?
           WHERE position = ?
             AND repo_owner = ? COLLATE NOCASE
             AND repo_name = ? COLLATE NOCASE
             AND base_sha IS NULL`,
          repository.baseSha,
          repository.position,
          repository.repoOwner,
          repository.repoName
        );
        if (repository.isPrimary) {
          this.sql.exec(
            `UPDATE session SET base_sha = ?
             WHERE repo_owner = ? COLLATE NOCASE
               AND repo_name = ? COLLATE NOCASE
               AND base_sha IS NULL`,
            repository.baseSha,
            repository.repoOwner,
            repository.repoName
          );
        }
      }
    });
  }
}
