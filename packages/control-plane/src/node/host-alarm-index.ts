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
 *
 * A claim is a lease. It carries the token of the delivery that holds it and
 * the time that hold runs out, and settling names the token, so a delivery
 * that comes back after its lease expired cannot settle the redelivery that
 * replaced it. Two things end a claim early, and they are different
 * questions: a claim no live delivery owns belongs to a process that is gone
 * (`recoverForeignClaims`, at start), and a claim whose lease ran out belongs
 * to a delivery that hung (`recoverExpiredClaims`, on every sweep). Only the
 * second counts a failure — a host that was killed did not fail to deliver,
 * but a handler that never returned did.
 */

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "./private-paths";
import { openPrivateSqliteFile } from "./sqlite-file";

interface SessionDeadline {
  sessionId: string;
  deadline: number;
}

export interface ClaimedDeadline {
  deadline: number;
  /** Failed deliveries of this alarm so far; arming a new deadline resets it. */
  failures: number;
  /** This claim's token; settling the delivery requires it. */
  token: string;
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
   * When the soonest claim's lease runs out, or null when nothing is
   * claimed. A claim recorded before leases existed reads as already
   * expired. This is on disk rather than in the clock's memory because a
   * claim outlives the delivery that held it — a settlement that could not
   * be written leaves one behind.
   */
  earliestLease(): number | null;
  /**
   * Up to `limit` sessions armed at or before `now`, soonest first, ignoring
   * `excluding`.
   */
  due(now: number, excluding: Iterable<string>, limit: number): SessionDeadline[];
  /**
   * Take the session's armed deadline for delivery until `leaseUntil`, with
   * the number of deliveries of this alarm that have already failed. Returns
   * null when nothing was armed. Until the claim is settled or recovered the
   * session reads as disarmed, so a handler that arms a new deadline replaces
   * nothing.
   */
  claim(sessionId: string, leaseUntil: number): ClaimedDeadline | null;
  /** The claimed delivery succeeded. Ignored unless `token` still holds it. */
  complete(sessionId: string, token: string): void;
  /**
   * The claimed delivery failed: count the failure and arm again at `at`, or
   * sooner if already armed. Ignored unless `token` still holds the claim.
   */
  retry(sessionId: string, token: string, at: number): void;
  /**
   * Re-arm every claim no live delivery owns, at its original deadline (or
   * sooner if the session armed one meanwhile), leaving the retry budget
   * alone. `ownedTokens` are the claims this process is still delivering, so
   * starting twice never takes one of them back. Returns the session ids
   * recovered.
   */
  recoverForeignClaims(ownedTokens: readonly string[]): string[];
  /**
   * Re-arm every claim whose lease has run out, counting the abandoned
   * delivery as a failure so a handler that always hangs runs out of retries
   * like one that always throws. Returns the session ids recovered.
   */
  recoverExpiredClaims(now: number): string[];
  close(): void;
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS session_deadlines (
  session_id TEXT PRIMARY KEY,
  deadline INTEGER,
  in_flight INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at INTEGER,
  CHECK (deadline IS NOT NULL OR in_flight IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_session_deadlines_deadline ON session_deadlines (deadline);
CREATE INDEX IF NOT EXISTS idx_session_deadlines_leases ON session_deadlines (lease_expires_at);`;

/**
 * The lease columns, for a file written before claims carried one. Both are
 * nullable with no default, so an existing row reads as a claim whose lease
 * has already run out — which is what a claim left by an older build is.
 */
const LEASE_COLUMNS = ["claim_token TEXT", "lease_expires_at INTEGER"] as const;

function addMissingColumns(db: DatabaseSync): void {
  const present = new Set(
    (
      db.prepare("SELECT name FROM pragma_table_info('session_deadlines')").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name)
  );
  for (const column of LEASE_COLUMNS) {
    const [name] = column.split(" ");
    if (present.has(name!)) continue;
    db.exec(`ALTER TABLE session_deadlines ADD COLUMN ${column}`);
  }
}

/** Open (creating if needed) the host's deadline index. */
export function openHostAlarmIndex(dataDir: string): HostAlarmIndex {
  ensurePrivateDirectory(dataDir);
  const db = openPrivateSqliteFile(join(dataDir, "host-alarms.db"));
  try {
    db.exec(SCHEMA_SQL);
    addMissingColumns(db);
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
    "DELETE FROM session_deadlines WHERE session_id = ? AND deadline IS NULL AND claim_token = ?"
  );
  const claimRow = db.prepare(
    `UPDATE session_deadlines
     SET in_flight = deadline, deadline = NULL, claim_token = ?, lease_expires_at = ?
     WHERE session_id = ? AND deadline IS NOT NULL RETURNING in_flight, failures`
  );
  // Every settlement names the claim it holds, so a delivery that came back
  // after its lease ran out cannot settle the one that replaced it.
  const settle = db.prepare(
    `UPDATE session_deadlines SET in_flight = NULL, failures = 0, claim_token = NULL, lease_expires_at = NULL
     WHERE session_id = ? AND claim_token = ?`
  );
  const armSooner = db.prepare(
    `UPDATE session_deadlines
     SET deadline = MIN(COALESCE(deadline, ?), ?), in_flight = NULL, failures = failures + 1,
         claim_token = NULL, lease_expires_at = NULL
     WHERE session_id = ? AND claim_token = ?`
  );
  const releaseClaims = (condition: string, countFailure: boolean) =>
    db.prepare(
      `UPDATE session_deadlines
       SET deadline = MIN(COALESCE(deadline, in_flight), in_flight), in_flight = NULL,
           failures = failures ${countFailure ? "+ 1" : "+ 0"},
           claim_token = NULL, lease_expires_at = NULL
       WHERE in_flight IS NOT NULL${condition} RETURNING session_id`
    );
  const recoverExpired = releaseClaims(" AND COALESCE(lease_expires_at, 0) <= ?", true);
  // Prepared per owned-token count and kept: a host delivers to a handful of
  // sessions at most, so the token list is inlined as placeholders.
  const foreignStatements = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
  const recoverForeign = (owned: number): ReturnType<DatabaseSync["prepare"]> => {
    const cached = foreignStatements.get(owned);
    if (cached) return cached;
    const exclusion =
      owned > 0
        ? ` AND COALESCE(claim_token, '') NOT IN (${Array.from({ length: owned }, () => "?").join(", ")})`
        : "";
    const statement = releaseClaims(exclusion, false);
    foreignStatements.set(owned, statement);
    return statement;
  };
  const soonestLease = db.prepare(
    `SELECT MIN(COALESCE(lease_expires_at, 0)) AS lease_expires_at FROM session_deadlines
     WHERE in_flight IS NOT NULL`
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
    earliestLease: () =>
      (soonestLease.get() as { lease_expires_at: number | null }).lease_expires_at,
    due: (now, excluding, limit) => armedRows(" AND deadline <= ?", [now], excluding, limit),
    claim: (sessionId, leaseUntil) => {
      const token = crypto.randomUUID();
      const row = claimRow.get(token, leaseUntil, sessionId) as
        | { in_flight: number; failures: number }
        | undefined;
      return row === undefined ? null : { deadline: row.in_flight, failures: row.failures, token };
    },
    complete: (sessionId, token) => {
      // Dropping first keeps the row's CHECK true: clearing `in_flight` on a
      // row with no armed deadline would leave both slots empty.
      dropDisarmed.run(sessionId, token);
      settle.run(sessionId, token);
    },
    retry: (sessionId, token, at) => {
      armSooner.run(at, at, sessionId, token);
    },
    recoverForeignClaims: (ownedTokens) =>
      (recoverForeign(ownedTokens.length).all(...ownedTokens) as Array<{ session_id: string }>).map(
        (row) => row.session_id
      ),
    recoverExpiredClaims: (now) =>
      (recoverExpired.all(now) as Array<{ session_id: string }>).map((row) => row.session_id),
    close: () => db.close(),
  };
}
