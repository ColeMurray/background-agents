import { describe, expect, it } from "vitest";
import { encodeSessionInboxCursor, parseSessionInboxCursor } from "./session-inbox-cursor";

describe("session inbox cursor", () => {
  it("round-trips a cursor", () => {
    const encoded = encodeSessionInboxCursor({
      latestUpdatedAt: 1234,
      rootSessionId: "session:/root",
    });

    expect(parseSessionInboxCursor(encoded)).toEqual({
      ok: true,
      cursor: { latestUpdatedAt: 1234, rootSessionId: "session:/root" },
    });
  });

  it.each(["not-base64", "", "e30"])("rejects malformed cursor %j", (cursor) => {
    expect(parseSessionInboxCursor(cursor)).toEqual({
      ok: false,
      error: "Invalid cursor",
    });
  });
});
