/**
 * The host's index of every session's next deadline: `<dataDir>/host-alarms.db`.
 *
 * A Durable Object's alarm lives with the object and the platform wakes a
 * hibernated object when it fires. On a Node host the session's own file
 * (`session_alarm_state`) stays the source of truth for *what* is pending,
 * and this index is what makes the deadline *fire*: it is the one place the
 * host clock (host-alarm-clock.ts) reads, for resident and evicted sessions
 * alike, and it survives a restart on the data volume.
 *
 * A row carries two slots. `deadline` is what the session armed and the
 * clock waits for. `in_flight` holds a deadline from the moment the clock
 * claims it for delivery until the delivery settles, so a process that dies
 * mid-delivery finds the claim at the next start and fires it again instead
 * of stranding an evicted session. `failures` counts failed deliveries of
 * the current alarm, on disk so a restart does not renew the retry budget.
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory, makeFilePrivate } from "./private-paths";

interface SessionDeadline {
  sessionId: string;
  deadline: number;
}

export interface ClaimedDeadline {
  deadline: number;
  /** Failed deliveries of this alarm so far; arming a new deadline resets it. */
  failures: number;
}

export interface HostAlarmIndex {
  /** The session's armed deadline, or null when none is armed. */
  get(sessionId: string): number | null;
  /** Arm (replacing any earlier armed deadline) the session's next deadline. */
  set(sessionId: string, deadline: number): void;
  /** Disarm the session. A claim in flight is unaffected. */
  delete(sessionId: string): void;
  /** The soonest armed deadline, ignoring the sessions in `excluding`. */
  earliest(excluding?: Iterable<string>): SessionDeadline | null;
  /**
   * Up to `limit` sessions armed at or before `now`, soonest first, ignoring
   * `excluding`.
   */
  due(now: number, excluding: Iterable<string>, limit: number): SessionDeadline[];
  /**
   * Take the session's armed deadline for delivery, with the number of
   * deliveries of this alarm that have already failed. Returns null when
   * nothing was armed. Until `complete` or `retry`, the session reads as
   * disarmed, so a handler that arms a new deadline replaces nothing.
   */
  claim(sessionId: string): ClaimedDeadline | null;
  /** The claimed delivery succeeded. */
  complete(sessionId: string): void;
  /**
   * The claimed delivery failed: count the failure and arm again at `at`, or
   * sooner if already armed.
   */
  retry(sessionId: string, at: number): void;
  /**
   * Re-arm every claim a previous process left in flight, at its original
   * deadline (or sooner if the session armed one meanwhile). Returns the
   * session ids recovered.
   */
  recoverClaims(): string[];
  close(): void;
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS session_deadlines (
  session_id TEXT PRIMARY KEY,
  deadline INTEGER,
  in_flight INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  CHECK (deadline IS NOT NULL OR in_flight IS NOT NULL)
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
  const arm = db.prepare(
    `INSERT INTO session_deadlines (session_id, deadline) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET deadline = excluded.deadline, failures = 0`
  );
  // Disarming or settling removes the row once neither slot is used, and
  // otherwise clears just the one slot; the order keeps the row's CHECK true.
  const dropUnclaimed = db.prepare(
    "DELETE FROM session_deadlines WHERE session_id = ? AND in_flight IS NULL"
  );
  const disarm = db.prepare("UPDATE session_deadlines SET deadline = NULL WHERE session_id = ?");
  const dropDisarmed = db.prepare(
    "DELETE FROM session_deadlines WHERE session_id = ? AND deadline IS NULL"
  );
  const claimRow = db.prepare(
    `UPDATE session_deadlines SET in_flight = deadline, deadline = NULL
     WHERE session_id = ? AND deadline IS NOT NULL RETURNING in_flight, failures`
  );
  const settle = db.prepare(
    "UPDATE session_deadlines SET in_flight = NULL, failures = 0 WHERE session_id = ?"
  );
  const armSooner = db.prepare(
    `UPDATE session_deadlines
     SET deadline = MIN(COALESCE(deadline, ?), ?), in_flight = NULL, failures = failures + 1
     WHERE session_id = ?`
  );
  const recover = db.prepare(
    `UPDATE session_deadlines SET deadline = MIN(COALESCE(deadline, in_flight), in_flight), in_flight = NULL
     WHERE in_flight IS NOT NULL RETURNING session_id`
  );
  const toDeadline = (row: unknown): SessionDeadline => {
    const { session_id, deadline } = row as { session_id: string; deadline: number };
    return { sessionId: session_id, deadline };
  };
  // Armed rows only, soonest first, minus the sessions the caller is already
  // delivering to. The exclusion is a handful of ids at most, so it is
  // inlined as placeholders rather than kept in a table.
  const armedRows = (
    condition: string,
    params: number[],
    excluding: Iterable<string>,
    limit: number
  ) => {
    const excluded = [...excluding];
    const exclusion =
      excluded.length > 0 ? ` AND session_id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    return db
      .prepare(
        `SELECT session_id, deadline FROM session_deadlines
         WHERE deadline IS NOT NULL${condition}${exclusion}
         ORDER BY deadline, session_id LIMIT ?`
      )
      .all(...params, ...excluded, limit)
      .map(toDeadline);
  };
  return {
    get: (sessionId) => {
      const row = read.get(sessionId) as { deadline: number | null } | undefined;
      return row?.deadline ?? null;
    },
    set: (sessionId, deadline) => {
      arm.run(sessionId, deadline);
    },
    delete: (sessionId) => {
      dropUnclaimed.run(sessionId);
      disarm.run(sessionId);
    },
    earliest: (excluding = []) => armedRows("", [], excluding, 1)[0] ?? null,
    due: (now, excluding, limit) => armedRows(" AND deadline <= ?", [now], excluding, limit),
    claim: (sessionId) => {
      const row = claimRow.get(sessionId) as { in_flight: number; failures: number } | undefined;
      return row === undefined ? null : { deadline: row.in_flight, failures: row.failures };
    },
    complete: (sessionId) => {
      dropDisarmed.run(sessionId);
      settle.run(sessionId);
    },
    retry: (sessionId, at) => {
      armSooner.run(at, at, sessionId);
    },
    recoverClaims: () =>
      (recover.all() as Array<{ session_id: string }>).map((row) => row.session_id),
    close: () => db.close(),
  };
}
