import type { ParticipantRole } from "@open-inspect/shared/types/sessions";
import type { SqlStorage } from "./sql-storage";
import { participantRowSchema, SessionStorageIntegrityError, type ParticipantRow } from "./types";

/** Data for creating a participant. */
interface CreateParticipantData {
  id: string;
  userId: string;
  canonicalUserId?: string | null;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
  role: ParticipantRole;
  joinedAt: number;
}

/** Data for updating a participant with COALESCE (only non-null values update). */
interface UpdateParticipantData {
  canonicalUserId?: string | null;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
}

/** Persistence for participants scoped to one session. */
export class ParticipantRepository {
  constructor(private readonly sql: SqlStorage) {}

  getParticipantByUserId(userId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE user_id = ?`, userId);
    const row = result.toArray()[0];
    return row === undefined ? null : parseParticipantRow(row);
  }

  getParticipantByWsTokenHash(tokenHash: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE ws_auth_token = ?`, tokenHash);
    const parsed = participantRowSchema.safeParse(result.toArray()[0]);
    return parsed.success ? parsed.data : null;
  }

  getParticipantById(participantId: string): ParticipantRow | null {
    const result = this.sql.exec(`SELECT * FROM participants WHERE id = ?`, participantId);
    const row = result.toArray()[0];
    return row === undefined ? null : parseParticipantRow(row);
  }

  createParticipant(data: CreateParticipantData): void {
    this.sql.exec(
      `INSERT INTO participants (id, user_id, canonical_user_id, scm_user_id, scm_login, scm_name, scm_email, role, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.id,
      data.userId,
      data.canonicalUserId ?? null,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
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
         scm_email = COALESCE(?, scm_email)
       WHERE id = ?`,
      data.canonicalUserId ?? null,
      data.scmUserId ?? null,
      data.scmLogin ?? null,
      data.scmName ?? null,
      data.scmEmail ?? null,
      participantId
    );
  }

  /** Replace an authoritative SCM snapshot, including cleared identity fields. */
  updateParticipantIdentity(
    participantId: string,
    data: {
      canonicalUserId: string;
      scmUserId: string | null;
      scmLogin: string | null;
      scmName: string | null;
      scmEmail: string | null;
    }
  ): void {
    this.sql.exec(
      `UPDATE participants SET canonical_user_id = ?, scm_user_id = ?, scm_login = ?,
         scm_name = ?, scm_email = ? WHERE id = ?`,
      data.canonicalUserId,
      data.scmUserId,
      data.scmLogin,
      data.scmName,
      data.scmEmail,
      participantId
    );
  }

  updateParticipantWsToken(participantId: string, tokenHash: string, createdAt: number): void {
    this.sql.exec(
      `UPDATE participants
       SET ws_auth_token = ?, ws_token_created_at = ?
       WHERE id = ?`,
      tokenHash,
      createdAt,
      participantId
    );
  }

  listParticipants(): ParticipantRow[] {
    const result = this.sql.exec(`SELECT * FROM participants ORDER BY joined_at`);
    return result.toArray().map((row) => parseParticipantRow(row));
  }
}

function parseParticipantRow(row: unknown): ParticipantRow {
  const parsed = participantRowSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  throw new SessionStorageIntegrityError("Malformed persisted participant row");
}
