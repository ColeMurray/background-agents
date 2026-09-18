import type { SqlDatabase } from "./sql-database";

export type SessionCreationClaimStatus = "claimed" | "created";

interface SessionCreationClaimRow {
  request_fingerprint: string;
  session_id: string;
  status: SessionCreationClaimStatus;
}

export interface SessionCreationClaim {
  sessionId: string;
  status: SessionCreationClaimStatus;
}

export class SessionCreationRequestConflictError extends Error {
  constructor() {
    super("clientRequestId was already used for a different session request");
    this.name = "SessionCreationRequestConflictError";
  }
}

/** Global D1 claim for idempotent session creation across Worker isolates. */
export class SessionCreationClaimStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(input: {
    userScope: string;
    clientRequestId: string;
    requestFingerprint: string;
    sessionId: string;
    now: number;
  }): Promise<SessionCreationClaim> {
    const [, selected] = await this.db.batch<SessionCreationClaimRow>([
      this.db
        .prepare(
          `INSERT INTO session_creation_claims
           (user_scope, client_request_id, request_fingerprint, session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'claimed', ?, ?)
           ON CONFLICT (user_scope, client_request_id) DO NOTHING`
        )
        .bind(
          input.userScope,
          input.clientRequestId,
          input.requestFingerprint,
          input.sessionId,
          input.now,
          input.now
        ),
      this.db
        .prepare(
          `SELECT request_fingerprint, session_id, status
           FROM session_creation_claims
           WHERE user_scope = ? AND client_request_id = ?`
        )
        .bind(input.userScope, input.clientRequestId),
    ]);

    const row = selected?.results[0];
    if (!row) throw new Error("Session creation claim was not persisted");
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw new SessionCreationRequestConflictError();
    }
    if (row.status !== "claimed" && row.status !== "created") {
      throw new Error("Session creation claim has an invalid status");
    }
    return {
      sessionId: row.session_id,
      status: row.status,
    };
  }

  async markCreated(
    userScope: string,
    clientRequestId: string,
    sessionId: string,
    now = Date.now()
  ): Promise<void> {
    const [claimResult] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE session_creation_claims
           SET status = 'created', updated_at = ?
           WHERE user_scope = ? AND client_request_id = ? AND session_id = ?`
        )
        .bind(now, userScope, clientRequestId, sessionId),
      this.db
        .prepare(
          `UPDATE sessions SET status = 'created', updated_at = MAX(updated_at, ?)
           WHERE id = ? AND status_revision = 0`
        )
        .bind(now, sessionId),
    ]);
    if ((claimResult?.meta.changes ?? 0) === 0) {
      throw new Error("Session creation claim could not be marked created");
    }
  }

  async markSessionFailedIfClaimed(
    userScope: string,
    clientRequestId: string,
    sessionId: string,
    now = Date.now()
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions SET status = 'failed', updated_at = MAX(updated_at, ?)
         WHERE id = ? AND status_revision = 0 AND EXISTS (
           SELECT 1 FROM session_creation_claims
           WHERE user_scope = ? AND client_request_id = ? AND session_id = ? AND status = 'claimed'
         )`
      )
      .bind(now, sessionId, userScope, clientRequestId, sessionId)
      .run();
  }
}
