import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { PersistedAlarmDeadlineStore } from "../session/alarm/scheduler";
import {
  HOST_STATE_FILE,
  markCleanShutdown,
  recoverSessionDeadlines,
  type DeadlineRecoveryReport,
} from "./crash-recovery";
import { openHostAlarmIndex, type HostAlarmIndex } from "./host-alarm-index";
import { openSessionStore } from "./session-store";

const BOOT_MS = 1_000_000;

let dataDir: string;
let index: HostAlarmIndex;
let log: Logger;

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A session file holding `deadline` as its pending deadline, and nothing else. */
function writeSessionDeadline(sessionId: string, deadline: number | null): void {
  const store = openSessionStore({ dataDir, sessionId });
  try {
    const deadlines = new PersistedAlarmDeadlineStore(store.storage.sql);
    if (deadline === null) deadlines.clear();
    else deadlines.setPending(deadline);
  } finally {
    store.close();
  }
}

function recover(nowMs = BOOT_MS): DeadlineRecoveryReport {
  return recoverSessionDeadlines({ dataDir, index, log, nowMs });
}

function marker(): { indexedThroughMs: number; cleanShutdown: boolean } {
  return JSON.parse(readFileSync(join(dataDir, HOST_STATE_FILE), "utf8")) as {
    indexedThroughMs: number;
    cleanShutdown: boolean;
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "oi-crash-recovery-"));
  index = openHostAlarmIndex(dataDir);
  log = fakeLogger();
});

afterEach(() => {
  index.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("recoverSessionDeadlines", () => {
  it("arms a deadline the session persisted and the index never recorded", () => {
    // Exactly the window the recovery exists for: the session committed its
    // deadline and the process died before the index row was written.
    writeSessionDeadline("stranded", 4_242);

    expect(recover()).toEqual({
      previousStop: "no_marker",
      scanned: 1,
      rearmed: 1,
      unreadable: 0,
    });
    expect(index.get("stranded")).toBe(4_242);
  });

  it("scans nothing after a clean shutdown, and invalidates the marker it read", () => {
    markCleanShutdown(dataDir, 500);
    writeSessionDeadline("stranded", 4_242);

    expect(recover()).toEqual({
      previousStop: "clean_shutdown",
      scanned: 0,
      rearmed: 0,
      unreadable: 0,
    });
    expect(index.get("stranded")).toBeNull();
    // The clean point stays where it was, so an unclean stop from here scans
    // forward from the shutdown rather than from this boot.
    expect(marker()).toEqual({ indexedThroughMs: 500, cleanShutdown: false });
  });

  it("scans after a boot that never wrote a clean marker of its own", () => {
    markCleanShutdown(dataDir, 500);
    recover(BOOT_MS);
    // That boot ran and died: no new clean marker, so its work is suspect.
    writeSessionDeadline("stranded", 4_242);

    expect(recover(BOOT_MS + 1)).toMatchObject({ previousStop: "unclean_stop", rearmed: 1 });
    expect(index.get("stranded")).toBe(4_242);
  });

  it("reads only the session files written since the last known-complete point", () => {
    writeSessionDeadline("before", 1_111);
    writeSessionDeadline("after", 2_222);
    // The clean point falls between the two writes: `before` was armed while
    // the previous process was still indexing, `after` may not have been.
    const secondsAt = (ms: number): number => ms / 1_000;
    utimesSync(join(dataDir, "sessions", "before.db"), secondsAt(BOOT_MS), secondsAt(BOOT_MS - 1));
    utimesSync(join(dataDir, "sessions", "after.db"), secondsAt(BOOT_MS), secondsAt(BOOT_MS + 1));
    writeFileSync(
      join(dataDir, HOST_STATE_FILE),
      JSON.stringify({ indexedThroughMs: BOOT_MS, cleanShutdown: false })
    );

    expect(recover()).toMatchObject({ previousStop: "unclean_stop", scanned: 1, rearmed: 1 });
    expect(index.get("after")).toBe(2_222);
    expect(index.get("before")).toBeNull();
  });

  it("does not postpone or replace a deadline the index already holds", () => {
    writeSessionDeadline("s1", 9_000);
    index.set("s1", 3_000);

    expect(recover()).toMatchObject({ scanned: 1, rearmed: 0 });
    expect(index.get("s1")).toBe(3_000);
  });

  it("arms nothing for a session whose alarm was cancelled", () => {
    writeSessionDeadline("cancelled", null);

    expect(recover()).toMatchObject({ scanned: 1, rearmed: 0 });
    expect(index.get("cancelled")).toBeNull();
  });

  it("skips a session file it cannot read and recovers the rest", () => {
    writeSessionDeadline("broken", 1_000);
    writeSessionDeadline("fine", 2_000);
    const broken = join(dataDir, "sessions", "broken.db");
    rmSync(`${broken}-wal`, { force: true });
    writeFileSync(broken, "not a database at all");
    chmodSync(broken, 0o600);

    expect(recover()).toMatchObject({ scanned: 2, rearmed: 1, unreadable: 1 });
    expect(index.get("fine")).toBe(2_000);
    expect(log.error).toHaveBeenCalledWith(
      "A session file could not be read for its scheduled deadline",
      expect.objectContaining({
        event: "node_host.deadline_recovery_failed",
        session_id: "broken",
      })
    );
  });

  it("keeps a session file it could not read in the next scan's range", () => {
    writeSessionDeadline("broken", 1_000);
    const broken = join(dataDir, "sessions", "broken.db");
    rmSync(`${broken}-wal`, { force: true });
    writeFileSync(broken, "not a database at all");
    chmodSync(broken, 0o600);
    // A boot after every file was last written, so the point it records is
    // what decides whether the file is looked at again.
    const bootMs = Date.now() + 1_000;

    expect(recover(bootMs)).toMatchObject({ scanned: 1, unreadable: 1 });
    expect(marker()).toEqual({ indexedThroughMs: 0, cleanShutdown: false });

    // The file has not been written since, and is read again all the same.
    expect(recover(bootMs + 1)).toMatchObject({ scanned: 1, unreadable: 1 });
  });

  it("treats a data directory with no sessions as nothing to do", () => {
    expect(recover()).toEqual({
      previousStop: "no_marker",
      scanned: 0,
      rearmed: 0,
      unreadable: 0,
    });
    // A first boot is not a crash: nothing is reported as recovered.
    expect(log.warn).not.toHaveBeenCalled();
    expect(marker()).toEqual({ indexedThroughMs: BOOT_MS, cleanShutdown: false });
  });

  it("reads an unusable marker as no marker and scans everything", () => {
    writeSessionDeadline("stranded", 4_242);
    writeFileSync(join(dataDir, HOST_STATE_FILE), "{ truncated");

    expect(recover()).toMatchObject({ previousStop: "no_marker", scanned: 1, rearmed: 1 });
  });

  it("leaves no partial marker behind when it replaces one", () => {
    markCleanShutdown(dataDir, 500);
    expect(existsSync(join(dataDir, `${HOST_STATE_FILE}.tmp`))).toBe(false);
    expect(marker()).toEqual({ indexedThroughMs: 500, cleanShutdown: true });
  });
});
