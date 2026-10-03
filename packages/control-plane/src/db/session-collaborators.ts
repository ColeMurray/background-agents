import { z } from "zod";
import type { SqlDatabase } from "./sql-database";
import { SessionAuditStore, type SessionAuditInput } from "./session-audit";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";

const collaboratorSchema = z.object({ session_id: z.string(), user_id: z.string() });

export class SessionCollaboratorStore {
  constructor(private readonly db: SqlDatabase) {}

  async listUserIds(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT session_id, user_id FROM session_collaborators WHERE session_id = ?")
      .bind(sessionId)
      .all();
    return rows.results.map((row) => collaboratorSchema.parse(row).user_id);
  }

  async listForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .prepare("SELECT session_id, user_id FROM session_collaborators WHERE user_id = ?")
      .bind(userId)
      .all();
    return rows.results.map((row) => collaboratorSchema.parse(row).session_id);
  }

  async listForSessions(
    sessionIds: readonly string[],
    options: { privateOnly?: boolean } = {}
  ): Promise<ReadonlyMap<string, string[]>> {
    const result = new Map<string, string[]>();
    const privateFilter = options.privateOnly
      ? `AND EXISTS (
           SELECT 1 FROM sessions
           WHERE sessions.id = session_collaborators.session_id AND sessions.visibility = 'private'
         )`
      : "";
    for (let offset = 0; offset < sessionIds.length; offset += MAX_D1_QUERY_PARAMETERS) {
      const ids = sessionIds.slice(offset, offset + MAX_D1_QUERY_PARAMETERS);
      const rows = await this.db
        .prepare(
          `SELECT session_id, user_id FROM session_collaborators
           WHERE session_id IN (${ids.map(() => "?").join(", ")})
           ${privateFilter}`
        )
        .bind(...ids)
        .all();
      for (const value of rows.results) {
        const row = collaboratorSchema.parse(value);
        result.set(row.session_id, [...(result.get(row.session_id) ?? []), row.user_id]);
      }
    }
    return result;
  }

  async add(
    sessionId: string,
    userId: string,
    addedBy: string,
    audit?: SessionAuditInput
  ): Promise<boolean> {
    const statement = this.db
      .prepare(
        `INSERT INTO session_collaborators (session_id, user_id, added_by, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (session_id, user_id) DO NOTHING`
      )
      .bind(sessionId, userId, addedBy, Date.now());
    const [result] = await this.db.batch([
      statement,
      ...(audit ? [new SessionAuditStore(this.db).bind(audit, true)] : []),
      this.db
        .prepare(
          `UPDATE session_memory_manifests SET personal_auto_save_eligible = 0
        WHERE session_id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id <> ?)`
        )
        .bind(sessionId, sessionId, userId),
    ]);
    return result.meta.changes > 0;
  }

  async remove(sessionId: string, userId: string, audit?: SessionAuditInput): Promise<boolean> {
    const statement = this.db
      .prepare("DELETE FROM session_collaborators WHERE session_id = ? AND user_id = ?")
      .bind(sessionId, userId);
    const result = audit
      ? (await this.db.batch([statement, new SessionAuditStore(this.db).bind(audit, true)]))[0]
      : await statement.run();
    return result.meta.changes > 0;
  }
}
