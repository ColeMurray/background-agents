/**
 * SessionRepository - Core session aggregate persistence.
 *
 * Feature-specific persistence can live in focused repositories that share
 * the same session-local SQL store. Cross-repository transactions remain
 * coordinated here when they also create or update core session records.
 */

import type { SessionRow, SandboxRow, SessionRepositoryRow } from "./types";
import type { GitSyncStatus } from "@open-inspect/shared/types/sandbox-events";
import type {
  SessionStatus,
  SandboxStatus,
  SpawnSource,
} from "@open-inspect/shared/types/sessions";
import { buildSessionRepositories, type SessionRepositoryEntry } from "./repository-target";
import type { SqlResult, SqlStorage, TransactionSync } from "./sql-storage";

/**
 * Minimal sandbox state for circuit breaker checks.
 * Only includes fields needed for spawn decisions.
 */
export interface SandboxCircuitBreakerState {
  status: string;
  created_at: number;
  modal_object_id: string | null;
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
 * Data for writing a session's member repository set — mirrors the
 * session_repositories columns the init path populates (per-repo git state
 * is written separately, by push handling).
 */
export interface SessionRepositoryData {
  position: number;
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
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
 * Data for spawn sandbox update.
 */
export interface SpawnSandboxData {
  status: SandboxStatus;
  createdAt: number;
  authTokenHash: string;
  modalSandboxId: string;
}

export interface ResumeSandboxData {
  status: SandboxStatus;
  createdAt: number;
}

/**
 * Core database operations for a session Durable Object.
 */
export class SessionRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transactionSync: TransactionSync
  ) {}

  private rows<T>(result: SqlResult): T[] {
    return result.toArray() as T[];
  }

  // === SESSION ===

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
    // Each session DO has exactly one session row
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

    // Intentionally consume result before reading rowsWritten so the count is final.
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

  // === SESSION REPOSITORIES ===

  /**
   * Replace the session's member repository set (DELETE + INSERT).
   * Per-repo git state columns (branch_name, base_sha, current_sha) reset
   * with the set — they describe work on the replaced members.
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
   * The session's repositories (see buildSessionRepositories for the
   * scalar-mirror fallback). Empty only for sessions without a repository
   * context.
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

  // === SANDBOX ===
  // Note: Each session DO has exactly one sandbox row, so update methods use
  // a subquery `WHERE id = (SELECT id FROM sandbox LIMIT 1)` to find it.

  getSandbox(): SandboxRow | null {
    const result = this.sql.exec(`SELECT * FROM sandbox LIMIT 1`);
    const rows = this.rows<SandboxRow>(result);
    return rows[0] ?? null;
  }

  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerState | null {
    const result = this.sql.exec(
      `SELECT status, created_at, modal_object_id, snapshot_image_id, spawn_failure_count, last_spawn_failure FROM sandbox LIMIT 1`
    );
    const rows = this.rows<SandboxCircuitBreakerState>(result);
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
         modal_sandbox_id = ?,
         modal_object_id = NULL,
         code_server_url = NULL,
         code_server_password = NULL,
         vnc_url = NULL,
         vnc_password = NULL,
         tunnel_urls = NULL,
         ttyd_url = NULL,
         ttyd_token = NULL
       WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      data.status,
      data.createdAt,
      data.authTokenHash,
      data.modalSandboxId
    );
  }

  updateSandboxForResume(data: ResumeSandboxData): void {
    this.sql.exec(
      `UPDATE sandbox SET
         status = ?,
         created_at = ?,
         last_heartbeat = NULL
       WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      data.status,
      data.createdAt
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

  updateSandboxCodeServer(url: string, password: string): void {
    this.sql.exec(
      `UPDATE sandbox SET code_server_url = ?, code_server_password = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      url,
      password
    );
  }

  clearSandboxCodeServer(): void {
    this.sql.exec(
      `UPDATE sandbox SET code_server_url = NULL, code_server_password = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  clearSandboxCodeServerUrl(): void {
    this.sql.exec(
      `UPDATE sandbox SET code_server_url = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  updateSandboxVnc(url: string, password: string): void {
    this.sql.exec(
      `UPDATE sandbox SET vnc_url = ?, vnc_password = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      url,
      password
    );
  }

  clearSandboxVnc(): void {
    this.sql.exec(
      `UPDATE sandbox SET vnc_url = NULL, vnc_password = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  clearSandboxVncUrl(): void {
    this.sql.exec(`UPDATE sandbox SET vnc_url = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`);
  }

  updateSandboxTunnelUrls(urls: Record<string, string>): void {
    this.sql.exec(
      `UPDATE sandbox SET tunnel_urls = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      JSON.stringify(urls)
    );
  }

  clearSandboxTunnelUrls(): void {
    this.sql.exec(
      `UPDATE sandbox SET tunnel_urls = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  updateSandboxTtyd(url: string, encryptedToken: string): void {
    this.sql.exec(
      `UPDATE sandbox SET ttyd_url = ?, ttyd_token = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      url,
      encryptedToken
    );
  }

  clearSandboxTtyd(): void {
    this.sql.exec(
      `UPDATE sandbox SET ttyd_url = NULL, ttyd_token = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
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
}
