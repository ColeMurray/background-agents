import type { SqlDatabase } from "./sql-database";

export async function activateSessionParticipantAccess(
  db: SqlDatabase,
  sessionId: string,
  userId: string,
  createdAt = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session_access
        (session_id, user_id, relation, state, generation, created_at)
       VALUES (?, ?, 'participant', 'active', 1, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         state = 'active', generation = session_access.generation + 1
       WHERE session_access.relation = 'participant' AND session_access.state <> 'active'`
    )
    .bind(sessionId, userId, createdAt)
    .run();
}
