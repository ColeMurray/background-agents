import { describe, expect, it } from "vitest";
import { encodeAuditEventCursor, parseAuditEventCursor } from "./audit-event-cursor";

describe("audit event cursor", () => {
  it("round-trips generated cursors and rejects malformed cursors", () => {
    const cursor = encodeAuditEventCursor({ occurredAt: 100, id: "event:1" });
    expect(cursor).toBe("100:event%3A1");
    expect(parseAuditEventCursor(cursor)).toEqual({
      ok: true,
      cursor: { occurredAt: 100, id: "event:1" },
    });
    for (const malformed of ["", "event-1", "100:", "100:%", "-1:event-1"]) {
      expect(parseAuditEventCursor(malformed)).toEqual({ ok: false, error: "Invalid cursor" });
    }
  });
});
