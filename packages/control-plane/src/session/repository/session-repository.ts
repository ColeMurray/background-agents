/**
 * SessionRepository implementation using SQLite.
 */

import type { SessionRepository } from "./types";
import type { SessionRow, SessionUpdate } from "../types";

/**
 * Create a SessionRepository instance backed by SQLite.
 */
export function createSessionRepository(sql: SqlStorage): SessionRepository {
  return {
    get(): SessionRow | null {
      const result = sql.exec(`SELECT * FROM session LIMIT 1`);
      const rows = result.toArray() as SessionRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: Omit<SessionRow, "created_at" | "updated_at">): SessionRow {
      const now = Date.now();

      sql.exec(
        `INSERT INTO session (
          id, session_name, title, repo_owner, repo_name, repo_default_branch,
          branch_name, base_sha, current_sha, opencode_session_id, model, status,
          created_at, updated_at, linear_issue_id, linear_team_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.id,
        data.session_name,
        data.title,
        data.repo_owner,
        data.repo_name,
        data.repo_default_branch,
        data.branch_name,
        data.base_sha,
        data.current_sha,
        data.opencode_session_id,
        data.model,
        data.status,
        now,
        now,
        data.linear_issue_id,
        data.linear_team_id
      );

      const created = this.get();
      if (!created) {
        throw new Error("Failed to create session");
      }
      return created;
    },

    update(updates: SessionUpdate): void {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (updates.title !== undefined) {
        sets.push("title = ?");
        params.push(updates.title);
      }

      if (updates.branchName !== undefined) {
        sets.push("branch_name = ?");
        params.push(updates.branchName);
      }

      if (updates.baseSha !== undefined) {
        sets.push("base_sha = ?");
        params.push(updates.baseSha);
      }

      if (updates.currentSha !== undefined) {
        sets.push("current_sha = ?");
        params.push(updates.currentSha);
      }

      if (updates.opencodeSessionId !== undefined) {
        sets.push("opencode_session_id = ?");
        params.push(updates.opencodeSessionId);
      }

      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }

      if (sets.length === 0) {
        return;
      }

      // Always update the updated_at timestamp
      sets.push("updated_at = ?");
      params.push(Date.now());

      sql.exec(`UPDATE session SET ${sets.join(", ")}`, ...params);
    },

    updateStatus(status: string): void {
      sql.exec(`UPDATE session SET status = ?, updated_at = ?`, status, Date.now());
    },

    updateCurrentSha(sha: string): void {
      sql.exec(`UPDATE session SET current_sha = ?, updated_at = ?`, sha, Date.now());
    },
  };
}
