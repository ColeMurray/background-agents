import {
  SESSION_DIFF_VERSION,
  sessionDiffFailureSchema,
  sessionDiffStateSchema,
  sessionDiffUploadSchema,
  storedSessionDiffBundleSchema,
  toSessionDiffManifest,
  type SessionDiffUpload,
  type SessionDiffState,
  type StoredSessionDiffBundle,
} from "@open-inspect/shared";
import type { SqlStorage } from "../sql-storage";

interface SessionDiffRow {
  revision_id: string | null;
  trigger_message_id: string | null;
  bundle_json: string | null;
  captured_at: number | null;
  last_error: string | null;
  error_at: number | null;
  updated_at: number;
}

/** Persists the single latest session-diff bundle in Durable Object SQLite. */
export class SessionDiffStore {
  constructor(private readonly sql: SqlStorage) {}

  /** Atomically replace the current bundle and clear any prior refresh failure. */
  replaceBundle(bundle: SessionDiffUpload, revisionId: string, now: number): void {
    storedSessionDiffBundleSchema.parse({ ...bundle, revisionId });
    this.sql.exec(
      `INSERT INTO session_diff (
         singleton, revision_id, trigger_message_id, bundle_json, captured_at,
         last_error, error_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         revision_id = excluded.revision_id,
         trigger_message_id = excluded.trigger_message_id,
         bundle_json = excluded.bundle_json,
         captured_at = excluded.captured_at,
         last_error = NULL,
         error_at = NULL,
         updated_at = excluded.updated_at`,
      revisionId,
      bundle.triggerMessageId,
      JSON.stringify(bundle),
      bundle.capturedAt,
      now
    );
  }

  /** Retain the current bundle while recording the latest refresh failure. */
  recordFailure(error: string, now: number): void {
    const failure = sessionDiffFailureSchema.parse({ error });
    this.sql.exec(
      `INSERT INTO session_diff (
         singleton, last_error, error_at, updated_at
       ) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         last_error = excluded.last_error,
         error_at = excluded.error_at,
         updated_at = excluded.updated_at`,
      failure.error,
      now,
      now
    );
  }

  /** Return the patch-free public manifest and current availability metadata. */
  getPublicState(unavailableReason: string | null): SessionDiffState {
    const row = this.readRow();
    const current = this.parseBundle(row);
    return sessionDiffStateSchema.parse({
      version: SESSION_DIFF_VERSION,
      current: current ? toSessionDiffManifest(current) : null,
      lastError:
        row?.last_error && row.error_at !== null
          ? { message: row.last_error, occurredAt: row.error_at }
          : null,
      unavailableReason,
    });
  }

  /** Resolve a renderable patch from the current revision without accepting stale identities. */
  resolveFile(
    revisionId: string,
    fileId: string
  ):
    | { ok: true; patch: string }
    | { ok: false; status: 404 | 409; currentRevisionId: string | null } {
    const bundle = this.parseBundle(this.readRow());
    const currentRevisionId = bundle?.revisionId ?? null;
    if (revisionId !== currentRevisionId) {
      return { ok: false, status: 409, currentRevisionId };
    }
    const file = bundle?.repositories
      .flatMap((repository) => repository.files)
      .find((candidate) => candidate.id === fileId);
    if (!file || file.renderState !== "renderable" || !("patch" in file) || !file.patch) {
      return { ok: false, status: 404, currentRevisionId };
    }
    return { ok: true, patch: file.patch };
  }

  private readRow(): SessionDiffRow | null {
    return (
      (
        this.sql
          .exec(`SELECT * FROM session_diff WHERE singleton = 1`)
          .toArray() as SessionDiffRow[]
      )[0] ?? null
    );
  }

  private parseBundle(row: SessionDiffRow | null): StoredSessionDiffBundle | null {
    if (!row?.bundle_json || !row.revision_id) return null;
    try {
      const upload = sessionDiffUploadSchema.safeParse(JSON.parse(row.bundle_json));
      if (!upload.success) return null;
      const stored = storedSessionDiffBundleSchema.safeParse({
        revisionId: row.revision_id,
        ...upload.data,
      });
      return stored.success ? stored.data : null;
    } catch {
      return null;
    }
  }
}
