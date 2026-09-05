/**
 * What the host does at boot about a stop it did not choose.
 *
 * A scheduled deadline is written twice. The session core commits it to the
 * session's own file (`session_alarm_state`) and then arms the runtime
 * alarm, which on this host is a row in the host alarm index. A Durable
 * Object writes both into one storage; here they are two files, so a process
 * that dies between them leaves a deadline the session knows about and the
 * index does not. Nothing is lost while the session stays resident — its
 * next activation re-arms the index through `rehydrate()` — but a session
 * that is never touched again never fires.
 *
 * The marker file (`<dataDir>/host-state.json`) is what tells the two stops
 * apart. It records the time through which the index is known to hold every
 * armed deadline, and whether the host reached that time by stopping
 * cleanly. A clean stop needs nothing at the next boot. Any other stop makes
 * the boot read the session files written since that time and arm each
 * file's earliest deadline into the index, which can only bring a wake-up
 * forward, never postpone or replace what the index already holds. The
 * marker is invalidated before the host serves anything, so a boot that
 * itself dies is the next boot's unclean stop.
 *
 * The files are read directly rather than opened through the registry: the
 * question is a two-column read, while activating a runtime reaches the
 * sockets and the sandbox provider, and a boot must not do that for every
 * session written since the last clean stop. Reading also leaves the session
 * unchanged, so a boot that dies part-way through a scan leaves the next
 * boot exactly the same work.
 */

import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger";
import { PersistedAlarmDeadlineStore } from "../session/alarm/scheduler";
import type { HostAlarmIndex } from "./host-alarm-index";
import { makeFilePrivate } from "./private-paths";
import { openPrivateSqliteFile } from "./sqlite-file";
import { createNodeSqlStorage } from "./sqlite-storage";

/** The marker's file inside the data directory. */
export const HOST_STATE_FILE = "host-state.json";

/** Where the per-session files live inside the data directory. */
const SESSIONS_DIRECTORY = "sessions";
/** What a session file is called; the rest of the name is the session id. */
const SESSION_FILE_SUFFIX = ".db";
/** The session table holding what the session has scheduled. */
const ALARM_STATE_TABLE = "session_alarm_state";

/** What the marker file holds. */
interface HostState {
  /** Every deadline armed before this time is in the host alarm index. */
  indexedThroughMs: number;
  /** The host stopped cleanly at that time, and armed nothing after it. */
  cleanShutdown: boolean;
}

/** How the previous process stopped, as the marker reports it. */
type PreviousStop = "clean_shutdown" | "unclean_stop" | "no_marker";

/** What a boot's recovery found and did. */
export interface DeadlineRecoveryReport {
  previousStop: PreviousStop;
  /** Session files read; zero after a clean stop. */
  scanned: number;
  /** Deadlines the index did not hold and now does. */
  rearmed: number;
  /** Session files that could not be read; each is logged and skipped. */
  unreadable: number;
}

export interface DeadlineRecoveryOptions {
  dataDir: string;
  index: HostAlarmIndex;
  log: Logger;
  /**
   * The boot's own time. Read before the scan, so a session written while
   * the scan runs is covered by the next one rather than missed.
   */
  nowMs: number;
}

/**
 * Restore into the index every deadline a session's file holds that the
 * index may have missed, and leave the marker saying the host is running.
 * Runs before anything can arm a deadline, and is safe to run when nothing
 * was lost: arming is a no-op for a deadline the index already holds.
 */
export function recoverSessionDeadlines(options: DeadlineRecoveryOptions): DeadlineRecoveryReport {
  const { dataDir, index, log, nowMs } = options;
  const previous = readHostState(dataDir);

  if (previous?.cleanShutdown === true) {
    // Nothing to scan, but the marker still has to stop saying so: the time
    // it names stays the last moment the index was known complete, and an
    // unclean stop from here scans forward from it.
    writeHostState(dataDir, {
      indexedThroughMs: previous.indexedThroughMs,
      cleanShutdown: false,
    });
    return { previousStop: "clean_shutdown", scanned: 0, rearmed: 0, unreadable: 0 };
  }

  // No marker at all names no clean point to scan from, so every session
  // file is read. On a fresh volume that is no files and no cost; on a
  // volume written by a build that predates the marker it is one full pass,
  // after which a marker exists.
  const previousStop: PreviousStop = previous === null ? "no_marker" : "unclean_stop";
  const scan = scanSessionFiles(dataDir, index, previous?.indexedThroughMs ?? null, log);
  writeHostState(dataDir, { indexedThroughMs: nowMs, cleanShutdown: false });

  const report: DeadlineRecoveryReport = { previousStop, ...scan };
  if (scan.scanned > 0) {
    log.warn("Re-armed scheduled deadlines from the session files after an unclean stop", {
      event: "node_host.deadlines_recovered",
      ...report,
    });
  }
  return report;
}

/**
 * Record that the host stopped cleanly at `atMs`, so the next boot scans
 * nothing. Only a shutdown that abandoned no work may call this: work that
 * outlived the drain budget can still arm a deadline the index would then be
 * missing.
 */
export function markCleanShutdown(dataDir: string, atMs: number): void {
  writeHostState(dataDir, { indexedThroughMs: atMs, cleanShutdown: true });
}

/** What `recoverSessionDeadlines` counts, before the reason is attached. */
type ScanCounts = Omit<DeadlineRecoveryReport, "previousStop">;

/**
 * Arm the earliest deadline of every session file written at or after
 * `sinceMs`, or of every session file when that is null.
 */
function scanSessionFiles(
  dataDir: string,
  index: HostAlarmIndex,
  sinceMs: number | null,
  log: Logger
): ScanCounts {
  const directory = join(dataDir, SESSIONS_DIRECTORY);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, rearmed: 0, unreadable: 0 };
    }
    throw error;
  }

  const counts: ScanCounts = { scanned: 0, rearmed: 0, unreadable: 0 };
  for (const entry of entries) {
    if (!entry.endsWith(SESSION_FILE_SUFFIX)) continue;
    const path = join(directory, entry);
    if (sinceMs !== null && lastWriteMs(path) < sinceMs) continue;
    counts.scanned += 1;
    const sessionId = entry.slice(0, -SESSION_FILE_SUFFIX.length);
    try {
      const deadline = earliestDeadline(path);
      if (deadline !== null && index.armIfSooner(sessionId, deadline)) counts.rearmed += 1;
    } catch (error) {
      // One unreadable file is one session that will not fire on its own.
      // It is not a reason to refuse the boot, which would take every other
      // session down with it.
      counts.unreadable += 1;
      log.error("A session file could not be read for its scheduled deadline", {
        event: "node_host.deadline_recovery_failed",
        session_id: sessionId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }
  return counts;
}

/**
 * The soonest deadline the session's own file holds, or null when it holds
 * none. The file is opened the way the host opens it, so a write-ahead log
 * the dead process left is recovered before the read, and the rule for what
 * counts as pending is the session core's own.
 */
function earliestDeadline(path: string): number | null {
  const db = openPrivateSqliteFile(path);
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(ALARM_STATE_TABLE);
    // A file whose schema was never applied has nothing scheduled.
    if (table === undefined) return null;
    return new PersistedAlarmDeadlineStore(createNodeSqlStorage(db).sql).earliest();
  } finally {
    db.close();
  }
}

/**
 * When the session was last written. A commit lands in the write-ahead log
 * and leaves the database file's own timestamp alone until a checkpoint, so
 * the log counts as a write to the session.
 */
function lastWriteMs(path: string): number {
  return Math.max(modifiedAtMs(path), modifiedAtMs(`${path}-wal`));
}

/** The file's last write, or 0 when there is no such file. */
function modifiedAtMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The marker, or null when there is none. A marker that cannot be read or
 * does not carry both fields is no marker: the boot has no clean point to
 * trust, and scanning everything is the answer that cannot be wrong.
 */
function readHostState(dataDir: string): HostState | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, HOST_STATE_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const state = parsed as Partial<HostState> | null;
  if (typeof state?.indexedThroughMs !== "number") return null;
  if (typeof state.cleanShutdown !== "boolean") return null;
  return { indexedThroughMs: state.indexedThroughMs, cleanShutdown: state.cleanShutdown };
}

/**
 * Replace the marker. Written beside its target and renamed over it, so a
 * process that dies mid-write leaves the previous marker rather than a
 * truncated one.
 */
function writeHostState(dataDir: string, state: HostState): void {
  const path = join(dataDir, HOST_STATE_FILE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  makeFilePrivate(temporary);
  renameSync(temporary, path);
}
