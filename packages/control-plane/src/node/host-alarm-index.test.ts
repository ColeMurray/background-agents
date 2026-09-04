import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHostAlarmIndex, type HostAlarmIndex } from "./host-alarm-index";

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
    expect(index.claim("s1")).toEqual({ deadline: 100, failures: 0 });
    expect(index.get("s1")).toBeNull();
    expect(index.earliest()).toBeNull();
    expect(index.claim("s1")).toBeNull();
    // A deadline armed during delivery is visible and survives completion.
    index.set("s1", 900);
    index.complete("s1");
    expect(index.get("s1")).toBe(900);
    index.delete("s1");
    expect(index.earliest()).toBeNull();
  });

  it("re-arms a failed claim at the retry time, or sooner if the session armed sooner", () => {
    const index = open();
    index.set("later", 100);
    index.claim("later");
    index.set("later", 5_000);
    index.retry("later", 1_000);
    expect(index.get("later")).toBe(1_000);
    // The failure is counted for the next claim of the same alarm.
    expect(index.claim("later")).toEqual({ deadline: 1_000, failures: 1 });
    index.retry("later", 2_000);
    expect(index.claim("later")).toEqual({ deadline: 2_000, failures: 2 });
    // Arming anew, or completing, starts the count over.
    index.set("later", 3_000);
    expect(index.claim("later")).toEqual({ deadline: 3_000, failures: 0 });
    index.retry("later", 4_000);
    index.complete("later");
    index.set("later", 5_000);
    expect(index.claim("later")).toEqual({ deadline: 5_000, failures: 0 });

    index.set("sooner", 100);
    index.claim("sooner");
    index.set("sooner", 200);
    index.retry("sooner", 1_000);
    expect(index.get("sooner")).toBe(200);
  });

  it("recovers claims left in flight at their original deadline, or sooner", () => {
    const first = open();
    first.set("crashed", 100);
    first.claim("crashed");
    first.set("rearmed", 100);
    first.claim("rearmed");
    first.set("rearmed", 50);
    first.set("idle", 700);
    first.close();

    const second = open();
    // Before recovery only armed deadlines count: the crashed claim is invisible.
    expect(second.earliest(["rearmed"])).toEqual({ sessionId: "idle", deadline: 700 });
    expect(second.recoverClaims().sort()).toEqual(["crashed", "rearmed"]);
    expect(second.due(100, [], 10)).toEqual([
      { sessionId: "rearmed", deadline: 50 },
      { sessionId: "crashed", deadline: 100 },
    ]);
    expect(second.recoverClaims()).toEqual([]);
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
