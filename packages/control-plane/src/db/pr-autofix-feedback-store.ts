import type { GitHubAutofixEnvelope } from "@open-inspect/shared";
import type { SqlDatabase } from "./sql-database";

export type PrAutofixDecision = "received" | "queued" | "skipped" | "failed";

export interface PrAutofixFeedbackRecord {
  feedbackKey: string;
  providerObjectKind: GitHubAutofixEnvelope["providerObject"]["kind"];
  providerObjectId: string;
  deliveryId: string;
  repositoryExternalId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  artifactId: string | null;
  sessionId: string | null;
  authorId: string | null;
  authorLogin: string | null;
  authorType: string | null;
  feedbackUrl: string | null;
  decision: PrAutofixDecision;
  reason: string | null;
  messageId: string | null;
  dispatchAttemptedAt: number | null;
  deliveryCount: number;
  lastError: string | null;
  firstReceivedAt: number;
  lastReceivedAt: number;
  decidedAt: number | null;
}

interface PrAutofixFeedbackRow {
  feedback_key: string;
  provider_object_kind: GitHubAutofixEnvelope["providerObject"]["kind"];
  provider_object_id: string;
  delivery_id: string;
  repository_external_id: string;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  artifact_id: string | null;
  session_id: string | null;
  author_id: string | null;
  author_login: string | null;
  author_type: string | null;
  feedback_url: string | null;
  decision: PrAutofixDecision;
  reason: string | null;
  message_id: string | null;
  dispatch_attempted_at: number | null;
  delivery_count: number;
  last_error: string | null;
  first_received_at: number;
  last_received_at: number;
  decided_at: number | null;
}

function toRecord(row: PrAutofixFeedbackRow): PrAutofixFeedbackRecord {
  return {
    feedbackKey: row.feedback_key,
    providerObjectKind: row.provider_object_kind,
    providerObjectId: row.provider_object_id,
    deliveryId: row.delivery_id,
    repositoryExternalId: row.repository_external_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    authorId: row.author_id,
    authorLogin: row.author_login,
    authorType: row.author_type,
    feedbackUrl: row.feedback_url,
    decision: row.decision,
    reason: row.reason,
    messageId: row.message_id,
    dispatchAttemptedAt: row.dispatch_attempted_at,
    deliveryCount: row.delivery_count,
    lastError: row.last_error,
    firstReceivedAt: row.first_received_at,
    lastReceivedAt: row.last_received_at,
    decidedAt: row.decided_at,
  };
}

interface ActivityCursor {
  lastReceivedAt: number;
  feedbackKey: string;
}

function encodeActivityCursor(cursor: ActivityCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeActivityCursor(cursor: string): ActivityCursor {
  try {
    const value = JSON.parse(atob(cursor)) as Partial<ActivityCursor>;
    if (
      typeof value.lastReceivedAt !== "number" ||
      !Number.isFinite(value.lastReceivedAt) ||
      typeof value.feedbackKey !== "string" ||
      !value.feedbackKey
    ) {
      throw new Error("invalid shape");
    }
    return {
      lastReceivedAt: value.lastReceivedAt,
      feedbackKey: value.feedbackKey,
    };
  } catch {
    throw new Error("Invalid Autofix activity cursor");
  }
}

export function githubAutofixFeedbackKey(envelope: GitHubAutofixEnvelope): string {
  return `github:${envelope.providerObject.kind}:${envelope.providerObject.id}`;
}

export class PrAutofixFeedbackStore {
  constructor(private readonly db: SqlDatabase) {}

  async receive(
    envelope: GitHubAutofixEnvelope,
    receivedAt: number
  ): Promise<PrAutofixFeedbackRecord> {
    const feedbackKey = githubAutofixFeedbackKey(envelope);
    await this.db
      .prepare(
        `INSERT INTO pr_autofix_feedback (
           feedback_key, provider_object_kind, provider_object_id, delivery_id,
           repository_external_id, repo_owner, repo_name, pr_number,
           decision, first_received_at, last_received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT(feedback_key) DO UPDATE SET
           delivery_id = excluded.delivery_id,
           delivery_count = pr_autofix_feedback.delivery_count + 1,
           last_received_at = excluded.last_received_at`
      )
      .bind(
        feedbackKey,
        envelope.providerObject.kind,
        envelope.providerObject.id,
        envelope.deliveryId,
        envelope.repository.id,
        envelope.repository.owner,
        envelope.repository.name,
        envelope.pullRequestNumber,
        receivedAt,
        receivedAt
      )
      .run();

    const record = await this.get(feedbackKey);
    if (!record) {
      throw new Error(`Autofix feedback receipt was not persisted: ${feedbackKey}`);
    }
    return record;
  }

  async get(feedbackKey: string): Promise<PrAutofixFeedbackRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM pr_autofix_feedback WHERE feedback_key = ?")
      .bind(feedbackKey)
      .first<PrAutofixFeedbackRow>();
    return row ? toRecord(row) : null;
  }

  async listActivity(options: {
    limit: number;
    cursor: string | null;
  }): Promise<{ records: PrAutofixFeedbackRecord[]; nextCursor: string | null }> {
    const cursor = options.cursor ? decodeActivityCursor(options.cursor) : null;
    const statement = cursor
      ? this.db
          .prepare(
            `SELECT * FROM pr_autofix_feedback
             WHERE last_received_at < ?
                OR (last_received_at = ? AND feedback_key < ?)
             ORDER BY last_received_at DESC, feedback_key DESC
             LIMIT ?`
          )
          .bind(cursor.lastReceivedAt, cursor.lastReceivedAt, cursor.feedbackKey, options.limit + 1)
      : this.db
          .prepare(
            `SELECT * FROM pr_autofix_feedback
             ORDER BY last_received_at DESC, feedback_key DESC
             LIMIT ?`
          )
          .bind(options.limit + 1);
    const result = await statement.all<PrAutofixFeedbackRow>();
    const hasMore = result.results.length > options.limit;
    const rows = hasMore ? result.results.slice(0, options.limit) : result.results;
    const records = rows.map(toRecord);
    const last = records.at(-1);
    return {
      records,
      nextCursor:
        hasMore && last
          ? encodeActivityCursor({
              lastReceivedAt: last.lastReceivedAt,
              feedbackKey: last.feedbackKey,
            })
          : null,
    };
  }

  async attachContext(
    feedbackKey: string,
    context: {
      artifactId: string;
      sessionId: string;
      authorId: string;
      authorLogin: string;
      authorType: string;
      feedbackUrl: string;
    }
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET artifact_id = ?, session_id = ?, author_id = ?, author_login = ?,
             author_type = ?, feedback_url = ?
         WHERE feedback_key = ?`
      )
      .bind(
        context.artifactId,
        context.sessionId,
        context.authorId,
        context.authorLogin,
        context.authorType,
        context.feedbackUrl,
        feedbackKey
      )
      .run();
  }

  async markDispatchAttempted(feedbackKey: string, attemptedAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET dispatch_attempted_at = ?
         WHERE feedback_key = ? AND decision = 'received'`
      )
      .bind(attemptedAt, feedbackKey)
      .run();
  }

  async markQueued(
    feedbackKey: string,
    messageId: string,
    reason: string,
    decidedAt: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET decision = 'queued', reason = ?, message_id = ?, last_error = NULL,
             decided_at = ?
         WHERE feedback_key = ?`
      )
      .bind(reason, messageId, decidedAt, feedbackKey)
      .run();
  }

  async markSkipped(feedbackKey: string, reason: string, decidedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET decision = 'skipped', reason = ?, last_error = NULL, decided_at = ?
         WHERE feedback_key = ? AND decision = 'received'`
      )
      .bind(reason, decidedAt, feedbackKey)
      .run();
    return result.meta.changes === 1;
  }

  async markFailed(
    feedbackKey: string,
    reason: string,
    error: string,
    decidedAt: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET decision = 'failed', reason = ?, last_error = ?, decided_at = ?
         WHERE feedback_key = ? AND decision = 'received'`
      )
      .bind(reason, error, decidedAt, feedbackKey)
      .run();
    return result.meta.changes === 1;
  }

  async recordError(feedbackKey: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE pr_autofix_feedback
         SET last_error = ?
         WHERE feedback_key = ? AND decision = 'received'`
      )
      .bind(error, feedbackKey)
      .run();
  }
}
