import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHostAlarmIndex, type ClaimedDeadline, type HostAlarmIndex } from "./host-alarm-index";

/** A lease no test outlives unless it means to. */
const LEASE_UNTIL = 10_000_000;

describe("openHostAlarmIndex", () => {
  let dataDir: string;
  const opened: HostAlarmIndex[] = [];
  const open = (): HostAlarmIndex => {
    const index = openHostAlarmIndex(dataDir);
    opened.push(index);
    return index;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "host-alarms-"));
  });

  afterEach(() => {
    for (const index of opened.splice(0)) {
      try {
        index.close();
      } catch {
        // already closed by the test
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("records, replaces, reads and forgets a session's deadline", () => {
    const index = open();
    expect(index.get("s1")).toBeNull();
    index.set("s1", 500);
    expect(index.get("s1")).toBe(500);
    index.set("s1", 300);
    expect(index.get("s1")).toBe(300);
    index.delete("s1");
    expect(index.get("s1")).toBeNull();
    expect(index.earliest()).toBeNull();
  });

  it("orders the earliest and the due deadlines soonest first", () => {
    const index = open();
    index.set("late", 900);
    index.set("soon", 100);
    index.set("mid", 500);
    expect(index.earliest()).toEqual({ sessionId: "soon", deadline: 100 });
    expect(index.due(500, [], 10)).toEqual([
      { sessionId: "soon", deadline: 100 },
      { sessionId: "mid", deadline: 500 },
    ]);
    expect(index.due(500, [], 1)).toEqual([{ sessionId: "soon", deadline: 100 }]);
    expect(index.due(99, [], 10)).toEqual([]);
  });

  it("claims a deadline for delivery, hides it while in flight, and completes it", () => {
    const index = open();
    index.set("s1", 100);
    const claimed = index.claim("s1", LEASE_UNTIL);
    expect(claimed).toMatchObject({ deadline: 100, failures: 0 });
    expect(claimed!.token).toEqual(expect.any(String));
    expect(index.get("s1")).toBeNull();
    expect(index.earliest()).toBeNull();
    expect(index.claim("s1", LEASE_UNTIL)).toBeNull();
    // A deadline armed during delivery is visible and survives completion.
    index.set("s1", 900);
    index.complete("s1", claimed!.token);
    expect(index.get("s1")).toBe(900);
    index.delete("s1");
    expect(index.earliest()).toBeNull();
  });

  it("refuses a settlement from a claim that no longer holds the session", () => {
    const index = open();
    index.set("s1", 100);
    const stale = index.claim("s1", 500)!;

    // The lease runs out and the session is claimed again.
    expect(index.recoverExpiredClaims(500)).toEqual(["s1"]);
    const live = index.claim("s1", LEASE_UNTIL)!;
    expect(live.token).not.toBe(stale.token);

    // The abandoned delivery comes back: neither settlement may touch the row.
    index.complete("s1", stale.token);
    index.retry("s1", stale.token, 9_000);
    expect(index.get("s1")).toBeNull();
    expect(index.claim("s1", LEASE_UNTIL)).toBeNull();

    // The delivery that does hold the claim settles it.
    index.retry("s1", live.token, 9_000);
    expect(index.get("s1")).toBe(9_000);
  });

  it("counts an expired claim as a failure but a foreign one as nothing", () => {
    const index = open();
    index.set("hung", 100);
    index.claim("hung", 500);
    // A handler that never returned: the abandoned delivery is a failed one.
    expect(index.recoverExpiredClaims(500)).toEqual(["hung"]);
    expect(index.claim("hung", LEASE_UNTIL)).toMatchObject({ failures: 1 });

    index.set("killed", 100);
    index.claim("killed", LEASE_UNTIL);
    // A host that was killed did not fail to deliver; its budget is untouched.
    expect(index.recoverForeignClaims([])).toContain("killed");
    expect(index.claim("killed", LEASE_UNTIL)).toMatchObject({ failures: 0 });
  });

  it("leaves a lease that still holds, and the claims a caller still owns", () => {
    const index = open();
    index.set("live", 100);
    const live = index.claim("live", 500)!;

    expect(index.recoverExpiredClaims(499)).toEqual([]);
    // Starting again must not take back a delivery this process is running.
    expect(index.recoverForeignClaims([live.token])).toEqual([]);
    expect(index.get("live")).toBeNull();

    expect(index.recoverForeignClaims(["someone-elses-token"])).toEqual(["live"]);
    expect(index.get("live")).toBe(100);
  });

  it("re-arms a failed claim at the retry time, or sooner if the session armed sooner", () => {
    const index = open();
    const take = (sessionId: string): ClaimedDeadline => index.claim(sessionId, LEASE_UNTIL)!;
    index.set("later", 100);
    let held = take("later");
    index.set("later", 5_000);
    index.retry("later", held.token, 1_000);
    expect(index.get("later")).toBe(1_000);
    // The failure is counted for the next claim of the same alarm.
    held = take("later");
    expect(held).toMatchObject({ deadline: 1_000, failures: 1 });
    index.retry("later", held.token, 2_000);
    held = take("later");
    expect(held).toMatchObject({ deadline: 2_000, failures: 2 });
    // Arming anew, or completing, starts the count over.
    index.set("later", 3_000);
    held = take("later");
    expect(held).toMatchObject({ deadline: 3_000, failures: 0 });
    index.retry("later", held.token, 4_000);
    held = take("later");
    index.complete("later", held.token);
    index.set("later", 5_000);
    expect(take("later")).toMatchObject({ deadline: 5_000, failures: 0 });

    index.set("sooner", 100);
    const sooner = take("sooner");
    index.set("sooner", 200);
    index.retry("sooner", sooner.token, 1_000);
    expect(index.get("sooner")).toBe(200);
  });

  it("recovers claims left in flight at their original deadline, or sooner", () => {
    const first = open();
    first.set("crashed", 100);
    first.claim("crashed", LEASE_UNTIL);
    first.set("rearmed", 100);
    first.claim("rearmed", LEASE_UNTIL);
    first.set("rearmed", 50);
    first.set("idle", 700);
    first.close();

    const second = open();
    // Before recovery only armed deadlines count: the crashed claim is invisible.
    expect(second.earliest(["rearmed"])).toEqual({ sessionId: "idle", deadline: 700 });
    // No delivery here owns them, however long their leases had left to run.
    expect(second.recoverForeignClaims([]).sort()).toEqual(["crashed", "rearmed"]);
    expect(second.due(100, [], 10)).toEqual([
      { sessionId: "rearmed", deadline: 50 },
      { sessionId: "crashed", deadline: 100 },
    ]);
    expect(second.recoverForeignClaims([])).toEqual([]);
  });

  it("treats a claim written before leases existed as one whose lease has run out", () => {
    const first = open();
    first.set("legacy", 100);
    first.claim("legacy", LEASE_UNTIL);
    first.close();

    // The shape an older build left behind: a claim with no lease recorded.
    const db = new DatabaseSync(join(dataDir, "host-alarms.db"));
    db.exec("UPDATE session_deadlines SET claim_token = NULL, lease_expires_at = NULL");
    db.close();

    const second = open();
    expect(second.recoverExpiredClaims(0)).toEqual(["legacy"]);
    expect(second.get("legacy")).toBe(100);
  });

  it("leaves excluded sessions out of earliest and due", () => {
    const index = open();
    index.set("a", 100);
    index.set("b", 200);
    expect(index.earliest(["a"])).toEqual({ sessionId: "b", deadline: 200 });
    expect(index.due(300, ["a", "b"], 10)).toEqual([]);
    expect(index.due(300, new Set(["b"]), 10)).toEqual([{ sessionId: "a", deadline: 100 }]);
  });

  it("survives close and reopen in a private file", () => {
    const first = open();
    first.set("s1", 700);
    first.close();
    expect(statSync(join(dataDir, "host-alarms.db")).mode & 0o777).toBe(0o600);
    expect(open().earliest()).toEqual({ sessionId: "s1", deadline: 700 });
    expect(existsSync(join(dataDir, "host-alarms.db"))).toBe(true);
  });
});
