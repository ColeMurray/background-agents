import { describe, expect, it } from "vitest";
import {
  encodeRunsExportCursor,
  encodeSessionExportCursor,
  parseRunsExportCursor,
  parseSessionExportCursor,
} from "./session-export-cursor";

describe("session export cursors", () => {
  it("round-trips a keyset and snapshot fence", () => {
    const cursor = { createdAt: 123, id: "session:encoded/id", snapshotMaxRowId: 456 };

    expect(parseSessionExportCursor(encodeSessionExportCursor(cursor))).toEqual({
      ok: true,
      cursor,
    });
  });

  it.each(["123:session", "123:session:0", "123:session:not-a-rowid"])(
    "rejects malformed cursor %s",
    (raw) => {
      expect(parseSessionExportCursor(raw)).toEqual({ ok: false, error: "Invalid cursor" });
    }
  );

  it("round-trips a runs keyset with encoded ids and its snapshot fence", () => {
    const cursor = {
      scope: "runs" as const,
      rootCreatedAt: 123,
      rootSessionId: "root:one/two",
      spawnDepth: 2,
      createdAt: 456,
      id: "child:three/four",
      snapshotMaxSequence: 789,
    };

    expect(parseRunsExportCursor(encodeRunsExportCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it("rejects cursors from the other scope", () => {
    const sessions = encodeSessionExportCursor({
      createdAt: 123,
      id: "session",
      snapshotMaxRowId: 5,
    });
    const runs = encodeRunsExportCursor({
      scope: "runs",
      rootCreatedAt: 123,
      rootSessionId: "root",
      spawnDepth: 0,
      createdAt: 123,
      id: "root",
      snapshotMaxSequence: 5,
    });
    expect(parseRunsExportCursor(sessions)).toEqual({ ok: false, error: "Invalid cursor" });
    expect(parseSessionExportCursor(runs)).toEqual({ ok: false, error: "Invalid cursor" });
  });

  it.each([
    "r:123:root:0:123:root",
    "r:123:root:-1:123:root:5",
    "r:123:root:0:123:root:9007199254740992",
    "r:123:root:0:123:%ZZ:5",
    "r:123::0:123:root:5",
  ])("rejects malformed runs cursor %s", (raw) => {
    expect(parseRunsExportCursor(raw)).toEqual({ ok: false, error: "Invalid cursor" });
  });
});
