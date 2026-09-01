import { describe, expect, it } from "vitest";
import { encodeAuditEventCursor, parseAuditEventCursor } from "./audit-event-cursor";

describe("audit event cursor", () => {
  it("round-trips generated cursors and rejects malformed or non-canonical cursors", () => {
    const cursor = encodeAuditEventCursor({ occurredAt: 100, id: "event:1" });
    expect(parseAuditEventCursor(cursor)).toEqual({
      ok: true,
      cursor: { occurredAt: 100, id: "event:1" },
    });
    for (const malformed of ["", "100:event-1", "v2.e30", "v1.%%%", "v1.e30"]) {
      expect(parseAuditEventCursor(malformed)).toEqual({ ok: false, error: "Invalid cursor" });
    }
  });
});
