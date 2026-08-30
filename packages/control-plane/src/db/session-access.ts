import type { SqlDatabase } from "./sql-database";

export async function activateSessionParticipantAccess(
  db: SqlDatabase,
  sessionId: string,
  userId: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session_access (session_id, user_id, relation)
       VALUES (?, ?, 'participant')
       ON CONFLICT(session_id, user_id) DO NOTHING`
    )
    .bind(sessionId, userId)
    .run();
}
