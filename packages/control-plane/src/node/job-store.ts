/**
 * The Node host's jobs table: `<dataDir>/jobs.db`.
 *
 * Cloudflare hands a job to a Queue and the platform redelivers it until a
 * consumer acknowledges. A container has no queue service, so the same
 * guarantee is a row: `send` writes one, the poller claims it, and the row
 * lives until a handler is done with it.
 *
 * A claim is a **lease**, as a queue's invisibility window is. Claiming
 * writes a fresh token and an expiry; settling names the token, so a
 * delivery that comes back after its lease expired cannot settle the
 * redelivery that replaced it. Two things end a claim early, and they answer
 * different questions: a claim no live delivery owns belongs to a process
 * that is gone (`recoverForeignClaims`, at start), and a claim whose lease
 * ran out belongs to a handler that hung (`recoverExpiredClaims`, on every
 * sweep). Naming the claims this process still holds is what keeps the first
 * from taking a job away from a delivery that is still running, so starting a
 * poller twice stays harmless. The cost of both is Cloudflare's own: two
 * deliveries of one job can overlap, which `jobs.ts` already requires every
 * handler to tolerate.
 *
 * Neither recovery refunds an attempt. The attempt is counted when the job
 * is claimed, exactly as a queue counts a delivery however it ended, so a
 * job whose handler takes the process down with it still runs out of
 * attempts and reaches the dead rows instead of being redelivered for ever.
 *
 * It is deliberately not part of the global store, whose schema is
 * `terraform/d1/migrations` and lands on D1 as well: nothing on Cloudflare
 * reads a jobs table. This is the arrangement the host alarm index and the
 * cache file already use — a Node-local file whose schema is a
 * `CREATE TABLE IF NOT EXISTS` in code, applied on open.
 *
 * Litestream does not replicate it, and that is a decision with a condition
 * attached. Every job the control plane produces today is
 * `image_build.finalize`, which the image-build scheduler republishes from
 * the global store on its cron slot (`listRecoverableFinalizations`: a build
 * still `building` with an accepted completion and no live lease). So a lost
 * volume loses no work, only time — the same reasoning that leaves the alarm
 * index unreplicated, where the session's own file re-arms the deadline. A
 * job kind that is *not* reconstructible from replicated state — session
 * callbacks, when those move onto this seam — has to revisit that.
 *
 * A row carries a status rather than a nullable slot per state, because
 * `dead` is a real destination here and not the absence of one: it is what a
 * dead-letter queue holds on the other host, kept with the error that put it
 * there. `run_at` is read only while a job is pending.
 */

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDirectory } from "./private-paths";
import { openPrivateSqliteFile } from "./sqlite-file";

export const JOB_STORE_FILE = "jobs.db";

/** A job as it was handed to `send`. */
interface StoredJob {
  id: string;
  kind: string;
  /** The job's payload, serialized. */
  payload: string;
  /** Not to be claimed before this time. */
  runAt: number;
}

/** A job leased for one attempt at running it. */
export interface ClaimedJob {
  id: string;
  kind: string;
  payload: string;
  /** Attempts including this one; 1 on the first. */
  attempts: number;
  /** This claim's token; settling the job requires it. */
  token: string;
}

/** What the jobs table holds right now, for the health report. */
export interface JobStoreStats {
  pending: number;
  running: number;
  dead: number;
  /**
   * How long the most overdue runnable job has been waiting past the time it
   * became runnable, or null when nothing is runnable. A job deliberately
   * delayed into the future is not late and is not counted. Every kind
   * counts, including one this build cannot claim: a lag that never clears
   * is how a stranded job gets noticed.
   */
  oldestRunnableLagMs: number | null;
}

export interface JobStore {
  /** Record a job to run at or after `job.runAt`. */
  add(job: StoredJob, now: number): void;
  /**
   * The soonest time a pending job of one of `kinds` may run, or null when
   * none is. Filtered exactly as `claim` is: a kind this build cannot claim
   * must not schedule a wake-up either, or a due one would be polled for
   * without end. Such a row is still counted by `stats`, where a lag that no
   * delivery clears is what a human needs to see.
   */
  earliest(kinds: readonly string[]): number | null;
  /**
   * Lease up to `limit` of the jobs runnable at `now` whose kind is one of
   * `kinds`, counting the attempt. Which jobs are taken is ordered — the
   * soonest runnable first — but the rows come back in whatever order the
   * update visited them, and callers run them concurrently anyway.
   *
   * A kind this build does not know is never claimed, so a job written by a
   * newer build waits for that build to come back rather than being consumed
   * by an older one.
   */
  claim(now: number, limit: number, kinds: readonly string[], leaseUntil: number): ClaimedJob[];
  /** The leased job succeeded: it is done and the row goes. */
  complete(id: string, token: string): void;
  /** The leased job failed or asked to be redelivered; run it again at `at`. */
  retry(id: string, token: string, at: number): void;
  /** The leased job will not be delivered again: keep the row with what ended it. */
  bury(id: string, token: string, error: string): void;
  /**
   * Return every claim no live delivery owns to pending, runnable at once.
   * `ownedTokens` are the claims this process is still delivering, so
   * starting a poller again never takes one of them back. Returns the job
   * ids recovered.
   */
  recoverForeignClaims(ownedTokens: readonly string[]): string[];
  /**
   * Return every claim whose lease has run out to pending, runnable at once.
   * Returns the job ids recovered.
   */
  recoverExpiredClaims(now: number): string[];
  stats(now: number): JobStoreStats;
  close(): void;
}

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  claim_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_runnable ON jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_leases ON jobs (status, lease_expires_at);`;

function open(path: string): DatabaseSync {
  const db = openPrivateSqliteFile(path);
  try {
    db.exec(SCHEMA_SQL);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Open (creating if needed) the host's jobs database. */
export function openJobStore(dataDir: string): JobStore {
  ensurePrivateDirectory(dataDir);
  const db = open(join(dataDir, JOB_STORE_FILE));

  const insert = db.prepare(
    `INSERT INTO jobs (id, kind, payload, status, run_at, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  );
  const remove = db.prepare("DELETE FROM jobs WHERE id = ? AND claim_token = ?");
  const reschedule = db.prepare(
    `UPDATE jobs SET status = 'pending', run_at = ?, claim_token = NULL, lease_expires_at = NULL
     WHERE id = ? AND claim_token = ?`
  );
  const kill = db.prepare(
    `UPDATE jobs SET status = 'dead', claim_token = NULL, lease_expires_at = NULL, last_error = ?
     WHERE id = ? AND claim_token = ?`
  );
  const releaseClaimsSql = (condition: string): string =>
    `UPDATE jobs SET status = 'pending', claim_token = NULL, lease_expires_at = NULL
     WHERE status = 'running'${condition} RETURNING id`;
  const recoverExpired = db.prepare(releaseClaimsSql(" AND lease_expires_at <= ?"));
  const countByStatus = db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status");
  const oldestRunnable = db.prepare(
    "SELECT MIN(run_at) AS run_at FROM jobs WHERE status = 'pending' AND run_at <= ?"
  );

  // Every list-filtered statement takes its list as inlined placeholders — a
  // handful of kinds from the code, or the tokens of the jobs this process is
  // delivering, neither of them a table — so each is prepared once per list
  // length and kept.
  const byListLength = (
    sql: (placeholders: string) => string
  ): ((length: number) => ReturnType<DatabaseSync["prepare"]>) => {
    const prepared = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
    return (length) => {
      const cached = prepared.get(length);
      if (cached) return cached;
      const statement = db.prepare(sql(Array.from({ length }, () => "?").join(", ")));
      prepared.set(length, statement);
      return statement;
    };
  };

  // A claim carrying no token at all predates leases, and is owned by no live
  // delivery whatever tokens this process holds.
  const recoverForeign = byListLength((placeholders) =>
    releaseClaimsSql(
      placeholders === "" ? "" : ` AND COALESCE(claim_token, '') NOT IN (${placeholders})`
    )
  );

  const soonestFor = byListLength(
    (placeholders) =>
      `SELECT MIN(run_at) AS run_at FROM jobs
       WHERE status = 'pending' AND kind IN (${placeholders})`
  );
  // The claim is one statement, so two pollers in this process cannot take
  // the same row: node:sqlite runs it to completion before either yields.
  const claimFor = byListLength(
    (placeholders) =>
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, claim_token = ?, lease_expires_at = ?
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status = 'pending' AND run_at <= ? AND kind IN (${placeholders})
         ORDER BY run_at, id LIMIT ?
       )
       RETURNING id, kind, payload, attempts`
  );

  return {
    add: ({ id, kind, payload, runAt }, now) => {
      insert.run(id, kind, payload, runAt, now);
    },
    earliest: (kinds) =>
      kinds.length === 0
        ? null
        : (soonestFor(kinds.length).get(...kinds) as { run_at: number | null }).run_at,
    claim: (now, limit, kinds, leaseUntil) => {
      if (kinds.length === 0) return [];
      const token = crypto.randomUUID();
      return claimFor(kinds.length)
        .all(token, leaseUntil, now, ...kinds, limit)
        .map((row) => {
          const { id, kind, payload, attempts } = row as {
            id: string;
            kind: string;
            payload: string;
            attempts: number;
          };
          return { id, kind, payload, attempts, token };
        });
    },
    complete: (id, token) => {
      remove.run(id, token);
    },
    retry: (id, token, at) => {
      reschedule.run(at, id, token);
    },
    bury: (id, token, error) => {
      kill.run(error, id, token);
    },
    recoverForeignClaims: (ownedTokens) =>
      (recoverForeign(ownedTokens.length).all(...ownedTokens) as Array<{ id: string }>).map(
        (row) => row.id
      ),
    recoverExpiredClaims: (now) =>
      (recoverExpired.all(now) as Array<{ id: string }>).map((row) => row.id),
    stats: (now) => {
      const counts = countByStatus.all() as Array<{ status: string; count: number }>;
      const countOf = (status: string): number =>
        counts.find((row) => row.status === status)?.count ?? 0;
      const oldest = (oldestRunnable.get(now) as { run_at: number | null }).run_at;
      return {
        pending: countOf("pending"),
        running: countOf("running"),
        dead: countOf("dead"),
        oldestRunnableLagMs: oldest === null ? null : Math.max(0, now - oldest),
      };
    },
    close: () => db.close(),
  };
}
