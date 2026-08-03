import type { SqlDatabase } from "./sql-database";

const IDEMPOTENCY_LEASE_MS = 15 * 60 * 1000;

interface IdempotencyRow {
  session_id: string;
  status: "initializing" | "succeeded" | "failed";
  lease_expires_at: number | null;
}

export type SessionCreationClaim =
  | { outcome: "claimed"; sessionId: string }
  | { outcome: "in_progress" }
  | { outcome: "succeeded"; sessionId: string };

export class SessionCreationIdempotencyStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(recordId: string, candidateSessionId: string): Promise<SessionCreationClaim> {
    const now = Date.now();
    const leaseExpiresAt = now + IDEMPOTENCY_LEASE_MS;
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO session_creation_idempotency
         (id, session_id, status, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, 'initializing', ?, ?, ?)`
      )
      .bind(recordId, candidateSessionId, leaseExpiresAt, now, now)
      .run();
    if (inserted.meta.changes > 0) return { outcome: "claimed", sessionId: candidateSessionId };

    const existing = await this.get(recordId);
    if (!existing) throw new Error("Session creation idempotency record disappeared");
    if (existing.status === "succeeded") {
      return { outcome: "succeeded", sessionId: existing.session_id };
    }
    if (existing.status === "initializing" && (existing.lease_expires_at ?? 0) > now) {
      return { outcome: "in_progress" };
    }

    if (existing.status === "initializing") {
      const session = await this.db
        .prepare("SELECT status FROM sessions WHERE id = ?")
        .bind(existing.session_id)
        .first<{ status: string }>();
      if (session && session.status !== "failed") {
        await this.markSucceeded(recordId, existing.session_id);
        return { outcome: "succeeded", sessionId: existing.session_id };
      }
    }

    const reclaimed = await this.db
      .prepare(
        `UPDATE session_creation_idempotency
         SET session_id = ?, status = 'initializing', lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND (status = 'failed' OR lease_expires_at <= ?)`
      )
      .bind(candidateSessionId, leaseExpiresAt, now, recordId, now)
      .run();
    return reclaimed.meta.changes > 0
      ? { outcome: "claimed", sessionId: candidateSessionId }
      : { outcome: "in_progress" };
  }

  async markSucceeded(recordId: string, sessionId: string): Promise<void> {
    await this.setStatus(recordId, sessionId, "succeeded");
  }

  async markFailed(recordId: string, sessionId: string): Promise<void> {
    await this.setStatus(recordId, sessionId, "failed");
  }

  private get(recordId: string): Promise<IdempotencyRow | null> {
    return this.db
      .prepare(
        `SELECT session_id, status, lease_expires_at
         FROM session_creation_idempotency WHERE id = ?`
      )
      .bind(recordId)
      .first<IdempotencyRow>();
  }

  private async setStatus(
    recordId: string,
    sessionId: string,
    status: "succeeded" | "failed"
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE session_creation_idempotency
         SET status = ?, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND session_id = ? AND status = 'initializing'`
      )
      .bind(status, Date.now(), recordId, sessionId)
      .run();
    if (result.meta.changes === 0) {
      throw new Error(`Session creation idempotency transition to ${status} was rejected`);
    }
  }
}
