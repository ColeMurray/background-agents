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
 * A claim is a lease: it carries the token of the delivery holding it and the
 * time that hold runs out. Settling names the token, so a claim recovered
 * from a process that is gone cannot be settled by a delivery that outlived
 * it. `recoverForeignClaims` is what recovers one — a claim no live delivery
 * owns belongs to a process that is gone — and naming the claims the caller
 * still holds is what lets it run more than once safely.
 *
 * `lease_expires_at` is read but never acted on here. The clock uses it to
 * stop counting a delivery that outlived its lease, and deliberately leaves
 * the claim on disk for the next start rather than re-arming it: nothing can
 * cancel the delivery still running, so redelivering would put two of them
 * into one session.
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
  /**
   * Arm `deadline` unless the index already holds one at or before it,
   * leaving the retry budget and any claim in flight alone. Returns whether
   * the index changed. This is how a deadline read back from a session's own
   * file is restored after an unclean stop: it can only bring the session's
   * next wake-up forward, never postpone or replace what the index holds.
   */
  armIfSooner(sessionId: string, deadline: number): boolean;
  /** Disarm the session. A claim in flight is unaffected. */
  delete(sessionId: string): void;
  /** The soonest armed deadline, ignoring the sessions in `excluding`. */
  earliest(excluding?: Iterable<string>): SessionDeadline | null;
  /**
   * When the soonest claim's lease runs out, or null when nothing is
   * claimed. This is on disk rather than in the clock's memory because a
   * claim outlives the delivery that held it — a settlement that could not
   * be written leaves one behind. A claim recorded before leases existed
   * carries none and is not counted: nothing here acts on an expired lease,
   * and the next `recoverForeignClaims` takes such a claim back anyway.
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
  close(): void;
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS session_deadlines (
  session_id TEXT PRIMARY KEY,
  deadline INTEGER,
  in_flight INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  lease_expires_at INTEGER,
  CHECK (deadline IS NOT NULL OR in_flight IS NOT NULL)
);`;

// Indexes come after the columns are known to exist: on a file written before
// the lease columns, the table statement above is a no-op and the lease index
// would name a column that is only added below.
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_session_deadlines_deadline ON session_deadlines (deadline);
CREATE INDEX IF NOT EXISTS idx_session_deadlines_leases ON session_deadlines (lease_expires_at)
  WHERE in_flight IS NOT NULL;`;

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
    db.exec(TABLE_SQL);
    addMissingColumns(db);
    db.exec(INDEX_SQL);
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
  const armSoonerUnlessArmed = db.prepare(
    `INSERT INTO session_deadlines (session_id, deadline) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET deadline = excluded.deadline
     WHERE deadline IS NULL OR deadline > excluded.deadline
     RETURNING session_id`
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
  // Prepared per owned-token count and kept: a host delivers to a handful of
  // sessions at most, so the token list is inlined as placeholders. The retry
  // budget is untouched — a host that was killed did not fail to deliver.
  const foreignStatements = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
  const recoverForeign = (owned: number): ReturnType<DatabaseSync["prepare"]> => {
    const cached = foreignStatements.get(owned);
    if (cached) return cached;
    const exclusion =
      owned > 0
        ? ` AND COALESCE(claim_token, '') NOT IN (${Array.from({ length: owned }, () => "?").join(", ")})`
        : "";
    const statement = db.prepare(
      `UPDATE session_deadlines
       SET deadline = MIN(COALESCE(deadline, in_flight), in_flight), in_flight = NULL,
           claim_token = NULL, lease_expires_at = NULL
       WHERE in_flight IS NOT NULL${exclusion} RETURNING session_id`
    );
    foreignStatements.set(owned, statement);
    return statement;
  };
  // Partial index territory: the predicate matches the index's own, and the
  // aggregate is over the bare column, so this reads one entry rather than
  // scanning every armed session.
  const soonestLease = db.prepare(
    `SELECT MIN(lease_expires_at) AS lease_expires_at FROM session_deadlines
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
    armIfSooner: (sessionId, deadline) =>
      armSoonerUnlessArmed.get(sessionId, deadline) !== undefined,
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
    close: () => db.close(),
  };
}
