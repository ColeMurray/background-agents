import { describe, expect, it } from "vitest";
import { encodeSessionExportCursor, parseSessionExportCursor } from "./session-export-cursor";

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
});
