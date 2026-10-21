import {
  sessionDiffUploadSchema,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";
import { z } from "zod";
import type { SqlStorage } from "../session/sql-storage";
import { assertPiDoTables } from "./schema";

const MAX_ERROR_LENGTH = 2_000;
export const REPOSITORY_DIFF_PUBLISH_TIMEOUT_MS = 15_000;

const rowSchema = z.object({
  generation: z.number().int().nonnegative(),
  pending_generation: z.number().int().nonnegative().nullable(),
  pending_json: z.string().nullable(),
  recapture_required: z.union([z.literal(0), z.literal(1)]),
  last_success_json: z.string().nullable(),
  last_error: z.string().nullable(),
  last_error_at: z.number().int().nonnegative().nullable(),
  permanent_error: z.string().nullable(),
});

export type RepositoryDiffPublicationOutcome = "published" | "idle" | "pending" | "permanent";

export class PermanentRepositoryDiffPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRepositoryDiffPublicationError";
  }
}

interface RepositoryDiffOutboxState {
  generation: number;
  pendingGeneration: number | null;
  pending: SessionDiffUpload | null;
  recaptureRequired: boolean;
  lastSuccessful: SessionDiffUpload | null;
  lastError: { message: string; occurredAt: number } | null;
  permanentError: string | null;
}

/** Durable, coalescing publication state owned by one PiSessionDO. */
export class RepositoryDiffOutbox {
  private initialized = false;
  private publishing: Promise<RepositoryDiffPublicationOutcome> | undefined;

  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => number = Date.now,
    private readonly publishTimeoutMs = REPOSITORY_DIFF_PUBLISH_TIMEOUT_MS
  ) {}

  async stage(bundle: SessionDiffUpload): Promise<number> {
    const generation = this.state().generation + 1;
    const encoded = JSON.stringify(
      sessionDiffUploadSchema.parse({ ...bundle, publicationGeneration: generation })
    );
    this.sql.exec(
      `INSERT INTO oi_pi_repository_diff_outbox
           (singleton, generation, pending_generation, pending_json, recapture_required,
            permanent_error, updated_at)
         VALUES (1, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
           pending_generation = excluded.pending_generation, pending_json = excluded.pending_json,
           recapture_required = 0, permanent_error = NULL, updated_at = excluded.updated_at`,
      generation,
      generation,
      encoded,
      this.now()
    );
    return generation;
  }

  async requestRecapture(): Promise<number> {
    const generation = this.state().generation + 1;
    this.sql.exec(
      `INSERT INTO oi_pi_repository_diff_outbox
         (singleton, generation, recapture_required, permanent_error, updated_at)
       VALUES (1, ?, 1, NULL, ?)
       ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
         recapture_required = 1, permanent_error = NULL, updated_at = excluded.updated_at`,
      generation,
      this.now()
    );
    return generation;
  }

  async recordCaptureFailure(error: unknown): Promise<number> {
    const generation = this.state().generation + 1;
    const now = this.now();
    this.sql.exec(
      `INSERT INTO oi_pi_repository_diff_outbox
           (singleton, generation, recapture_required, last_error, last_error_at, updated_at)
         VALUES (1, ?, 1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
           recapture_required = 1, last_error = excluded.last_error,
           last_error_at = excluded.last_error_at, updated_at = excluded.updated_at`,
      generation,
      boundedError(error),
      now,
      now
    );
    return generation;
  }

  async recordFailure(error: unknown): Promise<void> {
    this.ensureRow();
    this.recordError(error);
  }

  drain(
    publish: (bundle: SessionDiffUpload, signal: AbortSignal) => Promise<void>
  ): Promise<RepositoryDiffPublicationOutcome> {
    if (this.publishing) return Promise.resolve("pending");
    const work = this.publishLoop(publish);
    this.publishing = work;
    const clear = () => {
      if (this.publishing === work) this.publishing = undefined;
    };
    void work.then(clear, clear);
    return work;
  }

  private async publishLoop(
    publish: (bundle: SessionDiffUpload, signal: AbortSignal) => Promise<void>
  ): Promise<RepositoryDiffPublicationOutcome> {
    while (true) {
      const state = this.state();
      if (!state.pending) {
        if (state.recaptureRequired) return "pending";
        return state.permanentError ? "permanent" : "idle";
      }
      const pendingGeneration = state.pendingGeneration;
      if (pendingGeneration === null)
        throw new Error("Repository diff pending generation is missing");
      try {
        await this.publishWithDeadline(state.pending, publish);
      } catch (error) {
        if (error instanceof PermanentRepositoryDiffPublicationError) {
          const message = boundedError(error);
          const now = this.now();
          this.sql.exec(
            `UPDATE oi_pi_repository_diff_outbox
                SET pending_generation = NULL, pending_json = NULL, permanent_error = ?,
                    last_error = ?, last_error_at = ?, updated_at = ?
              WHERE singleton = 1 AND pending_generation = ?`,
            message,
            message,
            now,
            now,
            pendingGeneration
          );
          const current = this.state();
          if (current.pending) continue;
          return current.recaptureRequired ? "pending" : "permanent";
        }
        this.recordError(error);
        return "pending";
      }
      const encoded = JSON.stringify(state.pending);
      this.sql.exec(
        `UPDATE oi_pi_repository_diff_outbox
            SET pending_generation = NULL, pending_json = NULL, last_success_json = ?, updated_at = ?
          WHERE singleton = 1 AND pending_generation = ?`,
        encoded,
        this.now(),
        pendingGeneration
      );
      const current = this.state();
      if (current.pending) continue;
      return current.recaptureRequired ? "pending" : "published";
    }
  }

  state(): RepositoryDiffOutboxState {
    this.assertTable();
    const rows = this.sql
      .exec(
        `SELECT generation, pending_generation, pending_json, recapture_required,
                last_success_json, last_error, last_error_at, permanent_error
           FROM oi_pi_repository_diff_outbox WHERE singleton = 1`
      )
      .toArray();
    if (rows.length === 0) {
      return {
        generation: 0,
        pendingGeneration: null,
        pending: null,
        recaptureRequired: false,
        lastSuccessful: null,
        lastError: null,
        permanentError: null,
      };
    }
    const row = rowSchema.parse(rows[0]);
    return {
      generation: row.generation,
      pendingGeneration: row.pending_generation,
      pending: parseBundle(row.pending_json),
      recaptureRequired: row.recapture_required === 1,
      lastSuccessful: parseBundle(row.last_success_json),
      lastError:
        row.last_error === null || row.last_error_at === null
          ? null
          : { message: row.last_error, occurredAt: row.last_error_at },
      permanentError: row.permanent_error,
    };
  }

  private recordError(error: unknown): void {
    const message = boundedError(error);
    const now = this.now();
    this.sql.exec(
      `UPDATE oi_pi_repository_diff_outbox
          SET last_error = ?, last_error_at = ?, updated_at = ?
        WHERE singleton = 1`,
      message,
      now,
      now
    );
  }

  private async publishWithDeadline(
    bundle: SessionDiffUpload,
    publish: (bundle: SessionDiffUpload, signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const controller = new AbortController();
    let rejectTimeout!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      const error = new Error("Repository diff publication timed out");
      controller.abort(error);
      rejectTimeout(error);
    }, this.publishTimeoutMs);
    try {
      await Promise.race([publish(bundle, controller.signal), deadline]);
      if (controller.signal.aborted) throw controller.signal.reason;
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureRow(): void {
    this.assertTable();
    this.sql.exec(
      `INSERT OR IGNORE INTO oi_pi_repository_diff_outbox
         (singleton, generation, recapture_required, updated_at)
       VALUES (1, 0, 0, ?)`,
      this.now()
    );
  }

  private assertTable(): void {
    if (this.initialized) return;
    // The table is the Pi Durable Object's tracked migration's work, not this
    // outbox's: a missing table is a deployment that did not migrate.
    assertPiDoTables(this.sql, "oi_pi_repository_diff_outbox");
    this.initialized = true;
  }
}

function parseBundle(value: string | null): SessionDiffUpload | null {
  return value === null ? null : sessionDiffUploadSchema.parse(JSON.parse(value));
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH) || "Repository diff publication failed";
}
