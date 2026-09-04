/**
 * The host's index of every session's next deadline: `<dataDir>/host-alarms.db`.
 *
 * A Durable Object's alarm lives with the object and the platform wakes a
 * hibernated object when it fires. On a Node host the session's own file
 * (`session_alarm_state`) stays the source of truth for *what* is pending,
 * and this index is what makes the deadline *fire*: it is the one place the
 * host clock (host-alarm-clock.ts) reads, for resident and evicted sessions
 * alike, and it survives a restart on the data volume.
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, makeFilePrivate } from "./private-paths";

interface SessionDeadline {
  sessionId: string;
  deadline: number;
}

export interface HostAlarmIndex {
  /** The session's recorded deadline, or null when none is armed. */
  get(sessionId: string): number | null;
  /** Record (replacing any earlier record) the session's next deadline. */
  set(sessionId: string, deadline: number): void;
  /** Forget the session's deadline. */
  delete(sessionId: string): void;
  /** The soonest recorded deadline across all sessions. */
  earliest(): SessionDeadline | null;
  /** Every session whose deadline is at or before `now`, soonest first. */
  due(now: number): SessionDeadline[];
  close(): void;
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS session_deadlines (
  session_id TEXT PRIMARY KEY,
  deadline INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_deadlines_deadline ON session_deadlines (deadline);`;

/** Open (creating if needed) the host's deadline index. */
export function openHostAlarmIndex(dataDir: string): HostAlarmIndex {
  ensurePrivateDirectory(dataDir);
  const path = join(dataDir, "host-alarms.db");
  const db = new DatabaseSync(path);
  try {
    makeFilePrivate(path);
    db.exec(SCHEMA_SQL);
  } catch (error) {
    db.close();
    throw error;
  }
  const read = db.prepare("SELECT deadline FROM session_deadlines WHERE session_id = ?");
  const write = db.prepare(
    `INSERT INTO session_deadlines (session_id, deadline) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET deadline = excluded.deadline`
  );
  const remove = db.prepare("DELETE FROM session_deadlines WHERE session_id = ?");
  const first = db.prepare(
    "SELECT session_id, deadline FROM session_deadlines ORDER BY deadline, session_id LIMIT 1"
  );
  const dueBy = db.prepare(
    "SELECT session_id, deadline FROM session_deadlines WHERE deadline <= ? ORDER BY deadline, session_id"
  );
  const toDeadline = (row: unknown): SessionDeadline => {
    const { session_id, deadline } = row as { session_id: string; deadline: number };
    return { sessionId: session_id, deadline };
  };
  return {
    get: (sessionId) => {
      const row = read.get(sessionId) as { deadline: number } | undefined;
      return row?.deadline ?? null;
    },
    set: (sessionId, deadline) => {
      write.run(sessionId, deadline);
    },
    delete: (sessionId) => {
      remove.run(sessionId);
    },
    earliest: () => {
      const row = first.get();
      return row === undefined ? null : toDeadline(row);
    },
    due: (now) => dueBy.all(now).map(toDeadline),
    close: () => db.close(),
  };
}
