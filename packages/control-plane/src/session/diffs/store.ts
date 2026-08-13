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

/**
 * Columns that carry the stored patch state. Validated on its own so corrupt
 * refresh metadata can never discard an otherwise readable bundle.
 */
const sessionDiffBundleRowSchema = z.object({
  revision_id: z.string(),
  bundle_json: z.string(),
});

/**
 * Columns that carry the latest refresh failure. Validated on its own so a
 * corrupt bundle can never hide a real failure, and vice versa.
 */
const sessionDiffFailureRowSchema = z.object({
  last_error: z.string(),
  error_at: z.number().int().nonnegative(),
});

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
      lastError: this.parseFailure(row),
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

  private readRow(): unknown {
    return this.sql.exec(`SELECT * FROM session_diff WHERE singleton = 1`).toArray()[0] ?? null;
  }

  private parseBundle(row: unknown): StoredSessionDiffBundle | null {
    const bundleRow = sessionDiffBundleRowSchema.safeParse(row);
    if (!bundleRow.success) return null;
    try {
      const upload = sessionDiffUploadSchema.safeParse(JSON.parse(bundleRow.data.bundle_json));
      if (!upload.success) return null;
      const stored = storedSessionDiffBundleSchema.safeParse({
        revisionId: bundleRow.data.revision_id,
        ...upload.data,
      });
      return stored.success ? stored.data : null;
    } catch {
      return null;
    }
  }

  private parseFailure(row: unknown): SessionDiffState["lastError"] {
    const failureRow = sessionDiffFailureRowSchema.safeParse(row);
    if (!failureRow.success) return null;
    const failure = sessionDiffFailureSchema.safeParse({ error: failureRow.data.last_error });
    if (!failure.success) return null;
    return { message: failure.data.error, occurredAt: failureRow.data.error_at };
  }
}
