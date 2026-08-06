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
} from "@open-inspect/shared/types/session-diffs";
import { z } from "zod";
import type { SqlStorage } from "../sql-storage";
import { DiffFileNotFoundError, DiffRevisionStaleError } from "./errors";

const sessionDiffRowSchema = z.object({
  revision_id: z.string().nullable(),
  trigger_message_id: z.string().nullable(),
  bundle_json: z.string().nullable(),
  captured_at: z.number().nullable(),
  last_error: z.string().nullable(),
  error_at: z.number().nullable(),
  updated_at: z.number(),
});

type SessionDiffRow = z.infer<typeof sessionDiffRowSchema>;

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

  /**
   * Resolve a renderable patch from the current revision without accepting
   * stale identities. Throws DiffRevisionStaleError or DiffFileNotFoundError.
   */
  resolveFile(revisionId: string, fileId: string): string {
    const bundle = this.parseBundle(this.readRow());
    const currentRevisionId = bundle?.revisionId ?? null;
    if (revisionId !== currentRevisionId) {
      throw new DiffRevisionStaleError(currentRevisionId);
    }
    const file = bundle?.repositories
      .flatMap((repository) => repository.files)
      .find((candidate) => candidate.id === fileId);
    if (!file || file.renderState !== "renderable" || !("patch" in file) || !file.patch) {
      throw new DiffFileNotFoundError(currentRevisionId);
    }
    return file.patch;
  }

  private readRow(): SessionDiffRow | null {
    const row = this.sql.exec(`SELECT * FROM session_diff WHERE singleton = 1`).toArray()[0];
    if (!row) return null;
    const parsed = sessionDiffRowSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
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
