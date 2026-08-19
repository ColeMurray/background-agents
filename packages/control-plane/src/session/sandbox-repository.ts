import type { GitSyncStatus } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { SqlResult, SqlStorage } from "./sql-storage";
import type { SandboxRow } from "./types";

/** Minimal sandbox state needed for circuit breaker spawn decisions. */
export interface SandboxCircuitBreakerState {
  status: string;
  created_at: number;
  modal_object_id: string | null;
  snapshot_image_id: string | null;
  snapshot_runtime_version: string | null;
  spawn_failure_count: number | null;
  last_spawn_failure: number | null;
}

/** Data for creating a sandbox. */
export interface CreateSandboxData {
  id: string;
  status: SandboxStatus;
  gitSyncStatus: GitSyncStatus;
  createdAt: number;
}

/** Data for updating a sandbox during spawn. */
export interface SpawnSandboxData {
  status: SandboxStatus;
  createdAt: number;
  authTokenHash: string;
  modalSandboxId: string;
  preserveProviderObjectId?: boolean;
}

/** Data for updating a sandbox during an in-place resume. */
export interface ResumeSandboxData {
  status: SandboxStatus;
  createdAt: number;
}

/** Persistence for the sandbox scoped to one session. */
export class SandboxRepository {
  constructor(private readonly sql: SqlStorage) {}

  private rows<T>(result: SqlResult): T[] {
    return result.toArray() as T[];
  }

  getSandbox(): SandboxRow | null {
    const result = this.sql.exec(`SELECT * FROM sandbox LIMIT 1`);
    const rows = this.rows<SandboxRow>(result);
    return rows[0] ?? null;
  }

  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerState | null {
    const result = this.sql.exec(
      `SELECT status, created_at, modal_object_id, snapshot_image_id, snapshot_runtime_version, spawn_failure_count, last_spawn_failure FROM sandbox LIMIT 1`
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
         modal_object_id = ${data.preserveProviderObjectId ? "modal_object_id" : "NULL"},
         code_server_url = NULL,
         code_server_password = NULL,
         vnc_url = NULL,
         vnc_password = NULL,
         tunnel_urls = NULL,
         ttyd_url = NULL,
         ttyd_token = NULL,
         runtime_version = NULL
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

  updateSandboxModalObjectId(modalObjectId: string | null): void {
    this.sql.exec(
      `UPDATE sandbox SET modal_object_id = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      modalObjectId
    );
  }

  updateSandboxSnapshotImageId(
    sandboxId: string,
    imageId: string,
    runtimeVersion: string | null
  ): void {
    this.sql.exec(
      `UPDATE sandbox SET snapshot_image_id = ?, snapshot_runtime_version = ? WHERE id = ?`,
      imageId,
      runtimeVersion,
      sandboxId
    );
  }

  /**
   * Set the runtime version describing the sandbox's current filesystem.
   *
   * Used when the control plane already knows it authoritatively — restoring a
   * snapshot puts that snapshot's runtime on disk regardless of what the
   * provider exports into the new sandbox.
   */
  updateSandboxRuntimeVersion(runtimeVersion: string | null): void {
    this.sql.exec(
      `UPDATE sandbox SET runtime_version = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      runtimeVersion
    );
  }

  /**
   * Record the SANDBOX_VERSION a sandbox reported at startup, but only when
   * nothing authoritative is on the row yet.
   *
   * A fresh spawn clears the column, so its report lands. A restore seeds the
   * snapshot's version first, so a report is ignored: OpenComputer and Vercel
   * export the *current* SANDBOX_VERSION into every sandbox they start,
   * including ones forked from an old checkpoint, and trusting that would hand
   * a stale filesystem a clean bill of health.
   */
  recordReportedSandboxRuntimeVersion(runtimeVersion: string | null): void {
    this.sql.exec(
      `UPDATE sandbox SET runtime_version = ?
       WHERE runtime_version IS NULL AND id = (SELECT id FROM sandbox LIMIT 1)`,
      runtimeVersion
    );
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
