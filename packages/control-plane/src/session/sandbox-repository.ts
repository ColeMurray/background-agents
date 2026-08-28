import type {
  BootFailureCode,
  BootPhase,
  GitSyncStatus,
} from "@open-inspect/shared/types/sandbox-events";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { SqlResult, SqlStorage } from "./sql-storage";
import type { SandboxAccessKind, SandboxRow } from "./types";
import type { Logger } from "../logger";
import { coerceSandboxStatus } from "../sandbox/sandbox-status";
import { encryptToken } from "../auth/crypto";

/** A sandbox row exactly as SQLite returns it, before the status is validated. */
type RawSandboxRow = Omit<SandboxRow, "status"> & { status: string };

/** URL and secret columns backing each access artifact kind. */
const ACCESS_ARTIFACT_COLUMNS: Record<
  SandboxAccessKind,
  { urlColumn: string; secretColumn: string }
> = {
  codeServer: { urlColumn: "code_server_url", secretColumn: "code_server_password" },
  vnc: { urlColumn: "vnc_url", secretColumn: "vnc_password" },
  ttyd: { urlColumn: "ttyd_url", secretColumn: "ttyd_token" },
};

/** Minimal sandbox state needed for circuit breaker spawn decisions. */
export interface SandboxCircuitBreakerState {
  status: SandboxStatus;
  created_at: number;
  boot_progress_at: number | null;
  runtime_attach_started_at: number | null;
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
  modalSandboxId: string;
  preserveProviderObjectId?: boolean;
}

/** Data for updating a sandbox during an in-place resume. */
export interface ResumeSandboxData {
  status: SandboxStatus;
  createdAt: number;
}

export interface ProviderStartupPersistenceData {
  expectedSandboxId: string;
  expectedCreatedAt: number;
  providerObjectId: string | null;
  codeServer: { url: string; password: string } | null;
  vnc: { url: string; password: string } | null;
  tunnelUrls: Record<string, string> | null;
  ttyd: { url: string; token: string } | null;
  preserveMissing: boolean;
  runtimeAttachStartedAt: number;
}

/**
 * Persistence for the sandbox scoped to one session.
 *
 * Owns encrypt-at-rest for access secrets (code-server/VNC passwords, ttyd
 * tokens): callers hand over plaintext and every write path encrypts before
 * touching a column, so no caller can accidentally persist a secret in the
 * clear. Matches the D1 stores (`McpServerStore`, scoped secrets), which own
 * their keys the same way.
 */
export class SandboxRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly log: Logger,
    private readonly encryptionKey: string
  ) {}

  private rows<T>(result: SqlResult): T[] {
    return result.toArray() as T[];
  }

  /**
   * The session's sandbox row, with its status validated.
   *
   * Parsing happens here rather than at any individual consumer so every
   * caller sees the same value: the column is bare TEXT with no CHECK
   * constraint, and roughly forty sites read this status across snapshot,
   * access, alarm, WebSocket, and lifecycle paths. Coercing at one of them
   * would give the same row different semantics depending on which accessor a
   * caller happened to use.
   */
  getSandbox(): SandboxRow | null {
    const result = this.sql.exec(`SELECT * FROM sandbox LIMIT 1`);
    const rows = this.rows<RawSandboxRow>(result);
    const row = rows[0];
    return row ? { ...row, status: coerceSandboxStatus(row.status, this.log) } : null;
  }

  getSandboxWithCircuitBreaker(): SandboxCircuitBreakerState | null {
    const result = this.sql.exec(
      `SELECT status, created_at, boot_progress_at, runtime_attach_started_at, modal_object_id, snapshot_image_id, snapshot_runtime_version, spawn_failure_count, last_spawn_failure FROM sandbox LIMIT 1`
    );
    const rows = this.rows<Omit<SandboxCircuitBreakerState, "status"> & { status: string }>(result);
    const row = rows[0];
    return row ? { ...row, status: coerceSandboxStatus(row.status, this.log) } : null;
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

  attachRuntimeControl(sandboxId: string, timestamp: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET
         status = CASE WHEN status = 'snapshotting' THEN status ELSE 'booting' END,
         runtime_protocol_version = 2,
         last_heartbeat = ?
       WHERE modal_sandbox_id = ?
         AND status IN ('spawning', 'connecting', 'booting', 'ready', 'snapshotting')`,
      timestamp,
      sandboxId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  markExecutionReady(sandboxId: string, timestamp: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET
         status = CASE WHEN status = 'snapshotting' THEN status ELSE 'ready' END,
         ready_at = COALESCE(ready_at, ?),
         boot_phase = NULL,
         boot_phase_started_at = NULL
       WHERE modal_sandbox_id = ? AND status IN ('booting', 'ready', 'snapshotting')`,
      timestamp,
      sandboxId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  recordBootPhase(sandboxId: string, phase: BootPhase, timestamp: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET boot_phase = ?, boot_phase_started_at = ?
       WHERE modal_sandbox_id = ? AND status = 'booting'`,
      phase,
      timestamp,
      sandboxId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  failBoot(
    sandboxId: string,
    phase: BootPhase,
    code: BootFailureCode,
    message: string | undefined,
    timestamp: number
  ): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET
         status = 'failed',
         boot_phase = ?,
         boot_phase_started_at = ?,
         boot_failure_code = ?,
         last_spawn_error = ?,
         last_spawn_error_at = ?,
         code_server_url = NULL,
         code_server_password = NULL,
         vnc_url = NULL,
         vnc_password = NULL,
         tunnel_urls = NULL,
         ttyd_url = NULL,
         ttyd_token = NULL
       WHERE modal_sandbox_id = ?
         AND status IN ('spawning', 'connecting', 'booting')`,
      phase,
      timestamp,
      code,
      message ?? code,
      timestamp,
      sandboxId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  /**
   * Phase 1 of the two-phase spawn write (#1589): the reservation itself
   * invalidates credentials — no token can match the emptied hash — until
   * `updateSandboxAuthTokenHash` publishes the new one.
   */
  updateSandboxForSpawn(data: SpawnSandboxData): void {
    this.sql.exec(
      `UPDATE sandbox SET
         status = ?,
         created_at = ?,
         auth_token_hash = '',
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
         runtime_version = NULL,
         boot_progress_at = NULL,
         runtime_attach_started_at = NULL,
         runtime_protocol_version = NULL,
         boot_phase = NULL,
         boot_phase_started_at = NULL,
         boot_failure_code = NULL,
         ready_at = NULL
       WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      data.status,
      data.createdAt,
      data.modalSandboxId
    );
  }

  /**
   * Phase 2 of the two-phase spawn write (#1589): publish the reserved
   * identity's hash. Scoped to that identity so a delayed publisher cannot
   * attach its hash to a newer reservation; reports whether it applied.
   */
  updateSandboxAuthTokenHash(modalSandboxId: string, authTokenHash: string): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET auth_token_hash = ? WHERE modal_sandbox_id = ?`,
      authTokenHash,
      modalSandboxId
    );
    // Consume the result before reading rowsWritten so the count is final.
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  updateSandboxForResume(data: ResumeSandboxData): void {
    this.sql.exec(
      `UPDATE sandbox SET
         status = ?,
         created_at = ?,
         last_heartbeat = NULL,
         boot_progress_at = NULL,
         runtime_attach_started_at = NULL,
         runtime_protocol_version = NULL,
         boot_phase = NULL,
         boot_phase_started_at = NULL,
         boot_failure_code = NULL,
         ready_at = NULL
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

  failProviderOperationIfUnchanged(sandboxId: string, createdAt: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET status = 'failed'
       WHERE modal_sandbox_id = ?
         AND status IN ('spawning', 'connecting')
         AND created_at = ?
         AND runtime_attach_started_at IS NULL`,
      sandboxId,
      createdAt
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  failRuntimeAttachIfUnchanged(
    sandboxId: string,
    createdAt: number,
    runtimeAttachStartedAt: number,
    livenessAt: number
  ): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET status = 'failed'
       WHERE modal_sandbox_id = ?
         AND status = 'connecting'
         AND created_at = ?
         AND runtime_attach_started_at = ?
         AND MAX(runtime_attach_started_at, COALESCE(boot_progress_at, 0)) = ?`,
      sandboxId,
      createdAt,
      runtimeAttachStartedAt,
      livenessAt
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  async commitProviderStartup(data: ProviderStartupPersistenceData): Promise<boolean> {
    const value = (column: string): string =>
      data.preserveMissing ? `COALESCE(?, ${column})` : "?";
    const codeServerPassword = data.codeServer
      ? await this.encrypt(data.codeServer.password)
      : null;
    const vncPassword = data.vnc ? await this.encrypt(data.vnc.password) : null;
    const ttydToken = data.ttyd ? await this.encrypt(data.ttyd.token) : null;
    const result = this.sql.exec(
      `UPDATE sandbox SET
         modal_object_id = COALESCE(?, modal_object_id),
         code_server_url = ${value("code_server_url")},
         code_server_password = ${value("code_server_password")},
         vnc_url = ${value("vnc_url")},
         vnc_password = ${value("vnc_password")},
         tunnel_urls = ${value("tunnel_urls")},
         ttyd_url = ${value("ttyd_url")},
         ttyd_token = ${value("ttyd_token")},
         status = CASE WHEN status IN ('spawning', 'connecting') THEN 'connecting' ELSE status END,
         runtime_attach_started_at = CASE
           WHEN status IN ('spawning', 'connecting') THEN ?
           ELSE runtime_attach_started_at
         END
       WHERE modal_sandbox_id = ?
         AND created_at = ?
         AND status IN ('spawning', 'connecting', 'booting', 'ready', 'snapshotting')`,
      data.providerObjectId,
      data.codeServer?.url ?? null,
      codeServerPassword,
      data.vnc?.url ?? null,
      vncPassword,
      data.tunnelUrls ? JSON.stringify(data.tunnelUrls) : null,
      data.ttyd?.url ?? null,
      ttydToken,
      data.runtimeAttachStartedAt,
      data.expectedSandboxId,
      data.expectedCreatedAt
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  updateSandboxLastActivity(timestamp: number): void {
    this.sql.exec(
      `UPDATE sandbox SET last_activity = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      timestamp
    );
  }

  recordBootProgress(sandboxId: string, timestamp: number): boolean {
    const result = this.sql.exec(
      `UPDATE sandbox SET boot_progress_at = ?
       WHERE modal_sandbox_id = ? AND status IN ('spawning', 'connecting')`,
      timestamp,
      sandboxId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  updateSandboxGitSyncStatus(status: GitSyncStatus): void {
    this.sql.exec(
      `UPDATE sandbox SET git_sync_status = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      status
    );
  }

  setLastSpawnError(error: string | null, timestamp: number | null): void {
    this.sql.exec(
      `UPDATE sandbox SET last_spawn_error = ?, last_spawn_error_at = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      error,
      timestamp
    );
  }

  /** Set one access artifact's URL and encrypted secret. */
  async updateSandboxAccess(kind: SandboxAccessKind, url: string, secret: string): Promise<void> {
    const { urlColumn, secretColumn } = ACCESS_ARTIFACT_COLUMNS[kind];
    this.sql.exec(
      `UPDATE sandbox SET ${urlColumn} = ?, ${secretColumn} = ? WHERE id = (SELECT id FROM sandbox LIMIT 1)`,
      url,
      await this.encrypt(secret)
    );
  }

  /** Clear one access artifact's URL and secret. */
  clearSandboxAccess(kind: SandboxAccessKind): void {
    const { urlColumn, secretColumn } = ACCESS_ARTIFACT_COLUMNS[kind];
    this.sql.exec(
      `UPDATE sandbox SET ${urlColumn} = NULL, ${secretColumn} = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  /** Clear one access artifact's URL while preserving its stored secret. */
  clearSandboxAccessUrl(kind: SandboxAccessKind): void {
    const { urlColumn } = ACCESS_ARTIFACT_COLUMNS[kind];
    this.sql.exec(
      `UPDATE sandbox SET ${urlColumn} = NULL WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
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

  resetCircuitBreaker(): void {
    this.sql.exec(
      `UPDATE sandbox SET spawn_failure_count = 0 WHERE id = (SELECT id FROM sandbox LIMIT 1)`
    );
  }

  private encrypt(value: string): Promise<string> {
    return encryptToken(value, this.encryptionKey);
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
