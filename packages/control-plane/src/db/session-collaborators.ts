import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

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

  async add(sessionId: string, userId: string, addedBy: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO session_collaborators (session_id, user_id, added_by, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (session_id, user_id) DO NOTHING`
      )
      .bind(sessionId, userId, addedBy, Date.now())
      .run();
    return result.meta.changes > 0;
  }

  async remove(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM session_collaborators WHERE session_id = ? AND user_id = ?")
      .bind(sessionId, userId)
      .run();
    return result.meta.changes > 0;
  }
}
