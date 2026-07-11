import type { PullRequestLifecycleState, PullRequestSummary } from "@open-inspect/shared";

/**
 * One session's pull request as stored in D1 — the queryable authority record
 * for PR lifecycle tracking (design §4). Mirrors the session_pull_requests
 * table; the DO `pr` artifact is a live-view mirror of this record.
 */
export interface SessionPullRequestRecord {
  /** Matches the DO artifact id (primary key). */
  artifactId: string;
  sessionId: string;
  /** Stable provider repo id (canonical identity); null on legacy rows. */
  repositoryExternalId: string | null;
  /** Mutable lookup/display; refreshed when a rename/transfer is detected. */
  repoOwner: string;
  repoName: string;
  prNumber: number;
  url: string;
  lifecycleState: PullRequestLifecycleState;
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string | null;
  /** Provider's updated_at (epoch ms) — the monotonic guard source. */
  providerUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertResult {
  /**
   * False when the monotonic guard rejected a stale write (the stored
   * provider_updated_at is newer than the incoming one).
   */
  applied: boolean;
}

interface SessionPullRequestRow {
  artifact_id: string;
  session_id: string;
  repository_external_id: string | null;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  url: string;
  lifecycle_state: PullRequestLifecycleState;
  is_draft: number;
  head_branch: string;
  base_branch: string;
  head_sha: string | null;
  provider_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SummaryRow {
  session_id: string;
  total: number;
  open: number;
  draft: number;
  merged: number;
  closed: number;
}

function toRecord(row: SessionPullRequestRow): SessionPullRequestRecord {
  return {
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    repositoryExternalId: row.repository_external_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    url: row.url,
    lifecycleState: row.lifecycle_state,
    isDraft: row.is_draft === 1,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    headSha: row.head_sha,
    providerUpdatedAt: row.provider_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1 store for session_pull_requests. Every write path (creation, webhook,
 * read-through) funnels into the same plain upsert; ordering safety comes from
 * the SQL-side monotonic guard, not from claims or fencing (design §2.6).
 */
export class SessionPullRequestStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Insert the record, or update it in place when it already exists (by
   * artifact id). The update is guarded: a write whose providerUpdatedAt is
   * strictly older than the stored one is rejected, so an out-of-order
   * webhook cannot regress state. Writes without a timestamp on either side
   * are treated as authoritative (creation and read-through set one; a
   * missing value must not wedge the record).
   *
   * A conflicting row for the same PR identity under a *different* artifact
   * id violates the unique identity index and throws — one record per PR.
   */
  async upsert(record: SessionPullRequestRecord): Promise<UpsertResult> {
    const result = await this.db
      .prepare(
        `INSERT INTO session_pull_requests (
           artifact_id, session_id, repository_external_id, repo_owner, repo_name,
           pr_number, url, lifecycle_state, is_draft, head_branch, base_branch,
           head_sha, provider_updated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (artifact_id) DO UPDATE SET
           repository_external_id = excluded.repository_external_id,
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           pr_number = excluded.pr_number,
           url = excluded.url,
           lifecycle_state = excluded.lifecycle_state,
           is_draft = excluded.is_draft,
           head_branch = excluded.head_branch,
           base_branch = excluded.base_branch,
           head_sha = excluded.head_sha,
           provider_updated_at = excluded.provider_updated_at,
           updated_at = excluded.updated_at
         WHERE excluded.provider_updated_at IS NULL
            OR session_pull_requests.provider_updated_at IS NULL
            OR excluded.provider_updated_at >= session_pull_requests.provider_updated_at`
      )
      .bind(
        record.artifactId,
        record.sessionId,
        record.repositoryExternalId,
        record.repoOwner,
        record.repoName,
        record.prNumber,
        record.url,
        record.lifecycleState,
        record.isDraft ? 1 : 0,
        record.headBranch,
        record.baseBranch,
        record.headSha,
        record.providerUpdatedAt,
        record.createdAt,
        record.updatedAt
      )
      .run();

    return { applied: (result.meta.changes ?? 0) > 0 };
  }

  async getByArtifactId(artifactId: string): Promise<SessionPullRequestRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM session_pull_requests WHERE artifact_id = ?")
      .bind(artifactId)
      .first<SessionPullRequestRow>();

    return row ? toRecord(row) : null;
  }

  /** Canonical webhook lookup: stable provider repo id + PR number. */
  async getByExternalIdentity(
    repositoryExternalId: string,
    prNumber: number
  ): Promise<SessionPullRequestRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM session_pull_requests WHERE repository_external_id = ? AND pr_number = ?"
      )
      .bind(repositoryExternalId, prNumber)
      .first<SessionPullRequestRow>();

    return row ? toRecord(row) : null;
  }

  async getBySession(sessionId: string): Promise<SessionPullRequestRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM session_pull_requests WHERE session_id = ? ORDER BY created_at, pr_number"
      )
      .bind(sessionId)
      .all<SessionPullRequestRow>();

    return (result.results || []).map(toRecord);
  }

  /**
   * One grouped query producing per-session PR counts by display status for
   * the session list (mirrors the withRepositories join pattern). Sessions
   * without PR records are absent from the map.
   */
  async summariesForSessions(
    sessionIds: readonly string[]
  ): Promise<Map<string, PullRequestSummary>> {
    if (sessionIds.length === 0) return new Map();

    const placeholders = sessionIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT session_id,
                COUNT(*) AS total,
                SUM(CASE WHEN lifecycle_state = 'open' AND is_draft = 0 THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN lifecycle_state = 'open' AND is_draft = 1 THEN 1 ELSE 0 END) AS draft,
                SUM(CASE WHEN lifecycle_state = 'merged' THEN 1 ELSE 0 END) AS merged,
                SUM(CASE WHEN lifecycle_state = 'closed' THEN 1 ELSE 0 END) AS closed
         FROM session_pull_requests
         WHERE session_id IN (${placeholders})
         GROUP BY session_id`
      )
      .bind(...sessionIds)
      .all<SummaryRow>();

    const summaries = new Map<string, PullRequestSummary>();
    for (const row of result.results || []) {
      summaries.set(row.session_id, {
        total: row.total,
        open: row.open,
        draft: row.draft,
        merged: row.merged,
        closed: row.closed,
      });
    }
    return summaries;
  }

  /**
   * Explicit per-session cleanup. The FK cascade on sessions covers the
   * normal delete path; this exists for callers that clear PR records
   * without deleting the session.
   */
  async deleteBySession(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM session_pull_requests WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }
}
