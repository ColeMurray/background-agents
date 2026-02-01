/**
 * ParticipantRepository implementation using SQLite.
 */

import type { ParticipantRepository, CreateParticipantData } from "./types";
import type { ParticipantRow } from "../types";

/**
 * Create a ParticipantRepository instance backed by SQLite.
 */
export function createParticipantRepository(sql: SqlStorage): ParticipantRepository {
  return {
    getById(id: string): ParticipantRow | null {
      const result = sql.exec(`SELECT * FROM participants WHERE id = ? LIMIT 1`, id);
      const rows = result.toArray() as ParticipantRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    getByUserId(userId: string): ParticipantRow | null {
      const result = sql.exec(`SELECT * FROM participants WHERE user_id = ? LIMIT 1`, userId);
      const rows = result.toArray() as ParticipantRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    getByWsAuthToken(tokenHash: string): ParticipantRow | null {
      const result = sql.exec(
        `SELECT * FROM participants WHERE ws_auth_token = ? LIMIT 1`,
        tokenHash
      );
      const rows = result.toArray() as ParticipantRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: CreateParticipantData): ParticipantRow {
      sql.exec(
        `INSERT INTO participants (
          id, user_id, github_user_id, github_login, github_email, github_name,
          role, github_access_token_encrypted, github_refresh_token_encrypted,
          github_token_expires_at, ws_auth_token, ws_token_created_at, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.id,
        data.userId,
        data.githubUserId ?? null,
        data.githubLogin ?? null,
        data.githubEmail ?? null,
        data.githubName ?? null,
        data.role,
        data.githubAccessTokenEncrypted ?? null,
        data.githubRefreshTokenEncrypted ?? null,
        data.githubTokenExpiresAt ?? null,
        data.wsAuthToken ?? null,
        data.wsTokenCreatedAt ?? null,
        data.joinedAt
      );

      const created = this.getById(data.id);
      if (!created) {
        throw new Error(`Failed to create participant ${data.id}`);
      }
      return created;
    },

    updateTokens(
      id: string,
      data: {
        githubAccessTokenEncrypted?: string;
        githubRefreshTokenEncrypted?: string;
        githubTokenExpiresAt?: number;
      }
    ): void {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (data.githubAccessTokenEncrypted !== undefined) {
        sets.push("github_access_token_encrypted = ?");
        params.push(data.githubAccessTokenEncrypted);
      }

      if (data.githubRefreshTokenEncrypted !== undefined) {
        sets.push("github_refresh_token_encrypted = ?");
        params.push(data.githubRefreshTokenEncrypted);
      }

      if (data.githubTokenExpiresAt !== undefined) {
        sets.push("github_token_expires_at = ?");
        params.push(data.githubTokenExpiresAt);
      }

      if (sets.length === 0) {
        return;
      }

      sql.exec(`UPDATE participants SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    updateWsAuthToken(id: string, tokenHash: string | null, createdAt: number | null): void {
      sql.exec(
        `UPDATE participants SET ws_auth_token = ?, ws_token_created_at = ? WHERE id = ?`,
        tokenHash,
        createdAt,
        id
      );
    },

    list(): ParticipantRow[] {
      const result = sql.exec(`SELECT * FROM participants ORDER BY joined_at ASC`);
      return result.toArray() as ParticipantRow[];
    },
  };
}
