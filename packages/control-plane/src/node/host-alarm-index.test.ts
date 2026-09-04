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
    expect(index.due(500)).toEqual([
      { sessionId: "soon", deadline: 100 },
      { sessionId: "mid", deadline: 500 },
    ]);
    expect(index.due(99)).toEqual([]);
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
