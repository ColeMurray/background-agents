import type { ParticipantRole } from "@open-inspect/shared/types/sessions";
import type { SqlStorage } from "./sql-storage";
import type { ParticipantRow } from "./types";

/** Data for creating a participant. */
export interface CreateParticipantData {
  id: string;
  userId: string;
  canonicalUserId?: string | null;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmAccessTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
  role: ParticipantRole;
  joinedAt: number;
}

/** Data for updating a participant with COALESCE (only non-null values update). */
export interface UpdateParticipantData {
  canonicalUserId?: string | null;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  scmAccessTokenEncrypted?: string | null;
  scmRefreshTokenEncrypted?: string | null;
  scmTokenExpiresAt?: number | null;
}

/** Persistence for participants scoped to one session. */
export class ParticipantRepository {
  constructor(private readonly sql: SqlStorage) {}

  getParticipantByUserId(userId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE user_id = ?`, userId);
    return (result.toArray() as ParticipantRow[])[0] ?? null;
  }

  getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE ws_auth_token = ?`, tokenHash);
    return (result.toArray() as ParticipantRow[])[0] ?? null;
  }

  getParticipantById(participantId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE id = ?`, participantId);
    return (result.toArray() as ParticipantRow[])[0] ?? null;
  }

  createParticipant(data: CreateParticipantData): void {
    this.sql.exec(
      `INSERT INTO participants (id, user_id, canonical_user_id, scm_user_id, scm_login, scm_name, scm_email, scm_access_token_encrypted, scm_refresh_token_encrypted, scm_token_expires_at, role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.userId,
      data.canonicalUserId ?? null,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
      data.scmAccessTokenEncrypted ?? null,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt ?? null,
      data.role,
      data.joinedAt
    );
  }

  updateParticipantCoalesce(participantId: string, data: UpdateParticipantData): void {
    this.sql.exec(
      `UPDATE participants SET
         canonical_user_id = COALESCE(?, canonical_user_id),
         scm_user_id = COALESCE(?, scm_user_id),
         scm_login = COALESCE(?, scm_login),
         scm_name = COALESCE(?, scm_name),
         scm_email = COALESCE(?, scm_email),
         scm_access_token_encrypted = COALESCE(?, scm_access_token_encrypted),
         scm_refresh_token_encrypted = COALESCE(?, scm_refresh_token_encrypted),
         scm_token_expires_at = COALESCE(?, scm_token_expires_at)
       WHERE id = ?`,
      data.canonicalUserId ?? null,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
      data.scmAccessTokenEncrypted ?? null,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt ?? null,
      participantId
    );
  }

  updateParticipantTokens(
    participantId: string,
    data: {
      scmAccessTokenEncrypted: string;
      scmRefreshTokenEncrypted?: string | null;
      scmTokenExpiresAt: number;
    }
  ): void {
    this.sql.exec(
      `UPDATE participants SET
         scm_access_token_encrypted = ?,
         scm_refresh_token_encrypted = COALESCE(?, scm_refresh_token_encrypted),
         scm_token_expires_at = ?
       WHERE id = ?`,
      data.scmAccessTokenEncrypted,
      data.scmRefreshTokenEncrypted ?? null,
      data.scmTokenExpiresAt,
      participantId
    );
  }

  updateParticipantWsToken(participantId: string, tokenHash: string, createdAt: number): void {
    this.sql.exec(
      `UPDATE participants SET ws_auth_token = ?, ws_token_created_at = ? WHERE id = ?`,
      tokenHash,
      createdAt,
      participantId
    );
  }

  listParticipants(): ParticipantRow[] {
    const result = this.sql.exec(`SELECT * FROM participants ORDER BY joined_at`);
    return result.toArray() as ParticipantRow[];
  }
}
