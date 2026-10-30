import type { SqlDatabase } from "./sql-database";

export interface GitHubPrReviewClaim {
  sessionId: string;
  repositoryId: number;
  pullNumber: number;
  updatedAt: number;
}

/**
 * Which GitHub-bot review is current for a pull request.
 *
 * The claim is one transaction: mark every other current row for that pull
 * request superseded, then insert this session as current. A partial unique
 * index keeps two current rows from committing. Claiming the session that is
 * already current is a no-op.
 */
export class GitHubPrReviewStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(input: GitHubPrReviewClaim): Promise<string[]> {
    const [displaced] = await this.db.batch<{ session_id: string }>([
      this.db
        .prepare(
          `UPDATE github_pr_review_sessions
           SET superseded_by = ?, updated_at = ?
           WHERE repository_id = ? AND pull_number = ?
             AND superseded_by IS NULL
             AND session_id != ?
           RETURNING session_id`
        )
        .bind(
          input.sessionId,
          input.updatedAt,
          input.repositoryId,
          input.pullNumber,
          input.sessionId
        ),
      this.db
        .prepare(
          `INSERT INTO github_pr_review_sessions (
             session_id, repository_id, pull_number, superseded_by, updated_at
           ) VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(session_id) DO NOTHING`
        )
        .bind(input.sessionId, input.repositoryId, input.pullNumber, input.updatedAt),
    ]);
    return displaced.results.map((row) => {
      if (typeof row.session_id !== "string" || row.session_id.length === 0) {
        throw new Error("Review supersession returned an invalid session id");
      }
      return row.session_id;
    });
  }

  /**
   * Put a review back when cancelling it failed. The claimant stops being
   * current first, then the displaced session is current again, and only
   * while this claim still owns that displacement. A newer claim is left
   * alone. Returns whether this claim gave the displaced session back.
   */
  async restoreAfterFailedCancel(input: {
    claimantSessionId: string;
    displacedSessionId: string;
    updatedAt: number;
  }): Promise<boolean> {
    const [released] = await this.db.batch<{ session_id: string }>([
      this.db
        .prepare(
          `UPDATE github_pr_review_sessions
           SET superseded_by = ?, updated_at = ?
           WHERE session_id = ? AND superseded_by IS NULL
           RETURNING session_id`
        )
        .bind(input.displacedSessionId, input.updatedAt, input.claimantSessionId),
      this.db
        .prepare(
          `UPDATE github_pr_review_sessions
           SET superseded_by = NULL, updated_at = ?
           WHERE session_id = ?
             AND superseded_by = ?
             AND EXISTS (
               SELECT 1 FROM github_pr_review_sessions AS claimant
               WHERE claimant.session_id = ? AND claimant.superseded_by = ?
             )`
        )
        .bind(
          input.updatedAt,
          input.displacedSessionId,
          input.claimantSessionId,
          input.claimantSessionId,
          input.displacedSessionId
        ),
    ]);
    return released.results.length === 1;
  }

  /** True when a newer review has taken this session's pull request. */
  async isSuperseded(sessionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT superseded_by FROM github_pr_review_sessions WHERE session_id = ?`)
      .bind(sessionId)
      .first<{ superseded_by: string | null }>();
    return typeof row?.superseded_by === "string" && row.superseded_by.length > 0;
  }
}
