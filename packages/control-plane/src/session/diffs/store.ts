import {
  SESSION_DIFF_VERSION,
  SESSION_DIFF_MAX_CAPTURE_BYTES,
  SESSION_DIFF_MAX_FILES,
  sessionDiffStateSchema,
  type DiffCaptureCompleteRequest,
  type SessionDiffFile,
  type SessionDiffManifest,
  type SessionDiffState,
} from "@open-inspect/shared";
import type { SqlStorage } from "../sql-storage";

export const SESSION_DIFF_OBJECT_CLEANUP_GRACE_MS = 5 * 60 * 1_000;
const SESSION_DIFF_OBJECT_CLEANUP_RETRY_BASE_MS = 1_000;
const SESSION_DIFF_OBJECT_CLEANUP_RETRY_MAX_MS = 5 * 60 * 1_000;

type InternalSessionDiffFile = SessionDiffFile & { patchObjectKey?: string };
type InternalSessionDiffManifest = Omit<SessionDiffManifest, "repositories"> & {
  repositories: Array<
    Omit<SessionDiffManifest["repositories"][number], "files"> & {
      files: InternalSessionDiffFile[];
    }
  >;
};

interface SessionRepositoryBaseline {
  position: number;
  repoOwner: string;
  repoName: string;
  baseSha: string;
}

interface DiffObjectRow {
  object_key: string;
  capture_id: string;
  file_id: string;
  status: "staging" | "staged" | "referenced" | "cleanup";
  size_bytes: number | null;
}

export type DiffPublishResult =
  | { ok: true; revisionId: string }
  | { ok: false; status: 400 | 409; error: string };

interface DiffStateRow {
  baseline_status: "pending" | "ready" | "unavailable";
  baseline_reason: string | null;
  attempt_id: string | null;
  attempt_status: "idle" | "capturing" | "failed";
  attempt_started_at: number | null;
  attempt_error: string | null;
  ready_manifest: string | null;
  deleted_at: number | null;
}

export class SessionDiffStore {
  constructor(private readonly sql: SqlStorage) {}

  initializeNewSession(now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO diff_state (
         singleton, baseline_status, baseline_reason, attempt_status, updated_at
       ) VALUES (1, 'pending', NULL, 'idle', ?)`,
      now
    );
  }

  getBaselineStatus(): DiffStateRow["baseline_status"] | null {
    const rows = this.sql
      .exec(`SELECT baseline_status FROM diff_state WHERE singleton = 1`)
      .toArray() as Array<Pick<DiffStateRow, "baseline_status">>;
    return rows[0]?.baseline_status ?? null;
  }

  getDispatchBlockReason(): string | null {
    const rows = this.sql
      .exec(`SELECT baseline_status, attempt_status FROM diff_state WHERE singleton = 1`)
      .toArray() as Array<Pick<DiffStateRow, "baseline_status" | "attempt_status">>;
    const row = rows[0];
    if (!row || row.baseline_status === "pending") return "diff_baseline_pending";
    if (row.attempt_status === "capturing") return "diff_capture_pending";
    return null;
  }

  getCaptureTimeoutAt(timeoutMs: number): number | null {
    const rows = this.sql
      .exec(
        `SELECT attempt_started_at FROM diff_state
         WHERE singleton = 1 AND attempt_status = 'capturing'`
      )
      .toArray() as Array<{ attempt_started_at: number | null }>;
    const startedAt = rows[0]?.attempt_started_at;
    return startedAt == null ? null : startedAt + timeoutMs;
  }

  getNextCleanupAt(): number | null {
    const rows = this.sql
      .exec(
        `SELECT MIN(cleanup_after) AS cleanup_after FROM diff_objects
         WHERE status = 'cleanup' AND cleanup_after IS NOT NULL`
      )
      .toArray() as Array<{ cleanup_after: number | null }>;
    return rows[0]?.cleanup_after ?? null;
  }

  setBaselineReady(now: number): void {
    this.sql.exec(
      `UPDATE diff_state
       SET baseline_status = 'ready', baseline_reason = NULL, updated_at = ?
       WHERE singleton = 1 AND baseline_status = 'pending' AND deleted_at IS NULL`,
      now
    );
  }

  setBaselineUnavailable(reason: string, now: number): void {
    this.sql.exec(
      `UPDATE diff_state
       SET baseline_status = 'unavailable', baseline_reason = ?, updated_at = ?
       WHERE singleton = 1 AND baseline_status = 'pending' AND deleted_at IS NULL`,
      reason,
      now
    );
  }

  beginCapture(triggerMessageId: string, captureId: string, now: number): boolean {
    const trigger = this.sql.exec(
      `INSERT OR IGNORE INTO diff_capture_triggers (
         trigger_message_id, capture_id, created_at
       ) VALUES (?, ?, ?)`,
      triggerMessageId,
      captureId,
      now
    );
    trigger.toArray();
    if ((trigger.rowsWritten ?? 0) === 0) return false;

    const attempt = this.sql.exec(
      `UPDATE diff_state
       SET attempt_id = ?, attempt_trigger_message_id = ?, attempt_status = 'capturing',
           attempt_started_at = ?, attempt_error = NULL, updated_at = ?
       WHERE singleton = 1 AND deleted_at IS NULL
         AND baseline_status = 'ready' AND attempt_status != 'capturing'`,
      captureId,
      triggerMessageId,
      now,
      now
    );
    attempt.toArray();
    if ((attempt.rowsWritten ?? 0) > 0) return true;

    this.sql.exec(
      `DELETE FROM diff_capture_triggers WHERE trigger_message_id = ?`,
      triggerMessageId
    );
    return false;
  }

  failCapture(captureId: string, error: string, now: number): boolean {
    const result = this.sql.exec(
      `UPDATE diff_state
       SET attempt_status = 'failed', attempt_error = ?, updated_at = ?
       WHERE singleton = 1 AND attempt_id = ? AND attempt_status = 'capturing'`,
      error,
      now,
      captureId
    );
    result.toArray();
    const failed = (result.rowsWritten ?? 0) > 0;
    if (failed) this.markCaptureObjectsForCleanup(captureId, now);
    return failed;
  }

  stageObject(input: {
    captureId: string;
    fileId: string;
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    now: number;
  }): boolean {
    const active = this.sql
      .exec(
        `SELECT 1 FROM diff_state
         WHERE singleton = 1 AND deleted_at IS NULL
           AND attempt_id = ? AND attempt_status = 'capturing'`,
        input.captureId
      )
      .toArray();
    if (active.length === 0) return false;
    this.sql
      .exec(
        `INSERT INTO diff_objects (
           object_key, capture_id, file_id, status, size_bytes, sha256, cleanup_after, created_at
         ) VALUES (?, ?, ?, 'staging', ?, ?, NULL, ?)
         ON CONFLICT(object_key) DO UPDATE SET
           size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256,
           status = CASE WHEN diff_objects.status = 'referenced' THEN 'referenced' ELSE 'staging' END,
           cleanup_after = NULL`,
        input.objectKey,
        input.captureId,
        input.fileId,
        input.sizeBytes,
        input.sha256,
        input.now
      )
      .toArray();
    return true;
  }

  markObjectStaged(captureId: string, fileId: string): boolean {
    const result = this.sql.exec(
      `UPDATE diff_objects SET status = 'staged'
       WHERE capture_id = ? AND file_id = ? AND status = 'staging'`,
      captureId,
      fileId
    );
    result.toArray();
    return (result.rowsWritten ?? 0) > 0;
  }

  abandonObject(captureId: string, fileId: string, now: number): void {
    this.sql.exec(
      `UPDATE diff_objects SET status = 'cleanup', cleanup_after = ?
       WHERE capture_id = ? AND file_id = ? AND status != 'referenced'`,
      now,
      captureId,
      fileId
    );
  }

  publishCapture(
    captureId: string,
    request: DiffCaptureCompleteRequest,
    repositories: SessionRepositoryBaseline[],
    now: number
  ): DiffPublishResult {
    const stateRows = this.sql.exec(`SELECT * FROM diff_state WHERE singleton = 1`).toArray() as
      | DiffStateRow[]
      | undefined;
    const state = stateRows?.[0];
    if (
      !state ||
      state.deleted_at !== null ||
      state.attempt_id !== captureId ||
      state.attempt_status !== "capturing"
    ) {
      this.markCaptureObjectsForCleanup(captureId, now);
      return { ok: false, status: 409, error: "Diff capture is no longer active" };
    }
    if (request.repositories.length !== repositories.length) {
      return { ok: false, status: 400, error: "Repository membership does not match session" };
    }
    const successfulFiles = request.repositories.flatMap((repository) =>
      "files" in repository ? repository.files : []
    );
    const patchBytes = successfulFiles.reduce((total, file) => total + (file.patchBytes ?? 0), 0);
    if (
      successfulFiles.length > SESSION_DIFF_MAX_FILES ||
      patchBytes > SESSION_DIFF_MAX_CAPTURE_BYTES
    ) {
      return { ok: false, status: 400, error: "Diff capture exceeds session limits" };
    }

    const prior = this.parseInternalManifest(state.ready_manifest);
    const staged = this.sql
      .exec(
        `SELECT object_key, capture_id, file_id, status, size_bytes
         FROM diff_objects WHERE capture_id = ?`,
        captureId
      )
      .toArray() as unknown as DiffObjectRow[];
    const stagedByFile = new Map(staged.map((row) => [row.file_id, row]));
    const nextRepositories: InternalSessionDiffManifest["repositories"] = [];
    let successCount = 0;

    for (const repository of repositories) {
      const outcome = request.repositories.find(
        (candidate) => candidate.position === repository.position
      );
      if (
        !outcome ||
        outcome.repoOwner.toLowerCase() !== repository.repoOwner.toLowerCase() ||
        outcome.repoName.toLowerCase() !== repository.repoName.toLowerCase() ||
        outcome.baseSha.toLowerCase() !== repository.baseSha.toLowerCase()
      ) {
        return { ok: false, status: 400, error: "Repository baseline does not match session" };
      }

      if ("error" in outcome) {
        const previousRepository = prior?.repositories.find(
          (candidate) => candidate.position === repository.position
        );
        if (previousRepository?.status === "ready" || previousRepository?.status === "stale") {
          nextRepositories.push({ ...previousRepository, status: "stale", error: outcome.error });
        } else if (previousRepository) {
          nextRepositories.push({ ...previousRepository, error: outcome.error });
        } else {
          nextRepositories.push({
            ...repository,
            headSha: repository.baseSha,
            capturedAt: now,
            status: "unavailable",
            sourceCaptureId: captureId,
            truncated: false,
            omittedFileCount: 0,
            error: outcome.error,
            files: [],
          });
        }
        continue;
      }

      const files: InternalSessionDiffFile[] = [];
      for (const file of outcome.files) {
        const object = stagedByFile.get(file.id);
        if (file.renderState === "renderable") {
          if (
            !object ||
            object.status !== "staged" ||
            object.size_bytes !== file.patchBytes ||
            !file.patchBytes
          ) {
            return { ok: false, status: 400, error: `Patch upload is missing for file ${file.id}` };
          }
          files.push({ ...file, patchObjectKey: object.object_key });
        } else {
          files.push(file);
        }
      }
      successCount += 1;
      nextRepositories.push({
        ...outcome,
        capturedAt: now,
        status: "ready",
        sourceCaptureId: captureId,
        files,
      });
    }

    if (successCount === 0) {
      this.failCapture(captureId, "All repositories failed to capture", now);
      return { ok: false, status: 409, error: "All repositories failed to capture" };
    }

    const next: InternalSessionDiffManifest = {
      revisionId: captureId,
      capturedAt: now,
      triggerMessageId: this.getAttemptTriggerMessageId(),
      repositories: nextRepositories.sort((left, right) => left.position - right.position),
    };
    const nextObjectKeys = new Set(this.objectKeys(next));
    for (const objectKey of this.objectKeys(prior)) {
      if (!nextObjectKeys.has(objectKey)) {
        this.sql.exec(
          `UPDATE diff_objects SET status = 'cleanup', cleanup_after = ?
           WHERE object_key = ?`,
          now + SESSION_DIFF_OBJECT_CLEANUP_GRACE_MS,
          objectKey
        );
      }
    }
    for (const objectKey of nextObjectKeys) {
      this.sql.exec(
        `UPDATE diff_objects SET status = 'referenced', cleanup_after = NULL
         WHERE object_key = ?`,
        objectKey
      );
    }
    this.sql.exec(
      `UPDATE diff_objects SET status = 'cleanup', cleanup_after = ?
       WHERE capture_id = ? AND status IN ('staging', 'staged')`,
      now,
      captureId
    );
    this.sql.exec(
      `UPDATE diff_state
       SET attempt_status = 'idle', attempt_error = NULL, ready_manifest = ?,
           ready_updated_at = ?, updated_at = ?
       WHERE singleton = 1 AND attempt_id = ? AND attempt_status = 'capturing'`,
      JSON.stringify(next),
      now,
      now,
      captureId
    );
    return { ok: true, revisionId: captureId };
  }

  resolveFile(
    revisionId: string,
    fileId: string
  ):
    | { ok: true; objectKey: string; patchBytes: number }
    | { ok: false; status: 404 | 409; currentRevisionId: string | null } {
    const state = this.sql
      .exec(`SELECT ready_manifest FROM diff_state WHERE singleton = 1`)
      .toArray() as Array<Pick<DiffStateRow, "ready_manifest">>;
    const manifest = this.parseInternalManifest(state[0]?.ready_manifest ?? null);
    const currentRevisionId = manifest?.revisionId ?? null;
    if (revisionId !== currentRevisionId) {
      return { ok: false, status: 409, currentRevisionId };
    }
    const file = manifest?.repositories
      .flatMap((repository) => repository.files)
      .find((candidate) => candidate.id === fileId);
    if (!file?.patchObjectKey || file.renderState !== "renderable" || !file.patchBytes) {
      return { ok: false, status: 404, currentRevisionId };
    }
    return { ok: true, objectKey: file.patchObjectKey, patchBytes: file.patchBytes };
  }

  getCleanupObjects(now: number): string[] {
    return (
      this.sql
        .exec(
          `SELECT object_key FROM diff_objects
           WHERE status = 'cleanup' AND cleanup_after IS NOT NULL AND cleanup_after <= ?`,
          now
        )
        .toArray() as Array<{ object_key: string }>
    ).map((row) => row.object_key);
  }

  forgetObject(objectKey: string): void {
    this.sql.exec(`DELETE FROM diff_objects WHERE object_key = ?`, objectKey);
  }

  markAllObjectsForCleanup(now: number): string[] {
    this.sql.exec(
      `UPDATE diff_objects SET status = 'cleanup', cleanup_after = ? WHERE status != 'cleanup'`,
      now
    );
    return this.getCleanupObjects(now);
  }

  tombstoneForDeletion(now: number): string[] {
    this.sql.exec(
      `UPDATE diff_state
       SET deleted_at = ?, baseline_status = 'unavailable', baseline_reason = 'Session deleted',
           attempt_status = 'failed', attempt_error = 'Session deleted', ready_manifest = NULL,
           ready_updated_at = NULL, updated_at = ?
       WHERE singleton = 1 AND deleted_at IS NULL`,
      now,
      now
    );
    return this.markAllObjectsForCleanup(now);
  }

  isDeleted(): boolean {
    const rows = this.sql
      .exec(`SELECT deleted_at FROM diff_state WHERE singleton = 1`)
      .toArray() as Array<{ deleted_at: number | null }>;
    return rows[0]?.deleted_at != null;
  }

  deferObjectCleanup(objectKey: string, now: number): void {
    const rows = this.sql
      .exec(`SELECT cleanup_attempts FROM diff_objects WHERE object_key = ?`, objectKey)
      .toArray() as Array<{ cleanup_attempts: number }>;
    const attempts = rows[0]?.cleanup_attempts ?? 0;
    const retryDelay = Math.min(
      SESSION_DIFF_OBJECT_CLEANUP_RETRY_MAX_MS,
      SESSION_DIFF_OBJECT_CLEANUP_RETRY_BASE_MS * 2 ** Math.min(attempts, 8)
    );
    this.sql.exec(
      `UPDATE diff_objects
       SET status = 'cleanup', cleanup_attempts = cleanup_attempts + 1, cleanup_after = ?
       WHERE object_key = ?`,
      now + retryDelay,
      objectKey
    );
  }

  getPublicState(): SessionDiffState {
    const rows = this.sql.exec(`SELECT * FROM diff_state WHERE singleton = 1`).toArray() as
      | DiffStateRow[]
      | undefined;
    const row = rows?.[0];
    if (!row) {
      return {
        version: SESSION_DIFF_VERSION,
        baseline: {
          status: "unavailable",
          reason: "Changes were not captured when this session started",
        },
        attempt: { id: null, status: "idle", startedAt: null, error: null },
        current: null,
      };
    }

    return sessionDiffStateSchema.parse({
      version: SESSION_DIFF_VERSION,
      baseline: { status: row.baseline_status, reason: row.baseline_reason },
      attempt: {
        id: row.attempt_id,
        status: row.attempt_status,
        startedAt: row.attempt_started_at,
        error: row.attempt_error,
      },
      current: row.ready_manifest ? JSON.parse(row.ready_manifest) : null,
    });
  }

  private getAttemptTriggerMessageId(): string | null {
    const rows = this.sql
      .exec(`SELECT attempt_trigger_message_id FROM diff_state WHERE singleton = 1`)
      .toArray() as Array<{ attempt_trigger_message_id: string | null }>;
    return rows[0]?.attempt_trigger_message_id ?? null;
  }

  private parseInternalManifest(value: string | null): InternalSessionDiffManifest | null {
    if (!value) return null;
    try {
      return JSON.parse(value) as InternalSessionDiffManifest;
    } catch {
      return null;
    }
  }

  private objectKeys(manifest: InternalSessionDiffManifest | null): string[] {
    if (!manifest) return [];
    return manifest.repositories.flatMap((repository) =>
      repository.files.flatMap((file) => (file.patchObjectKey ? [file.patchObjectKey] : []))
    );
  }

  private markCaptureObjectsForCleanup(captureId: string, now: number): void {
    this.sql.exec(
      `UPDATE diff_objects SET status = 'cleanup', cleanup_after = ?
       WHERE capture_id = ? AND status != 'referenced'`,
      now,
      captureId
    );
  }
}
