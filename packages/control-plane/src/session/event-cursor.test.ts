import { describe, expect, it } from "vitest";
import {
  encodeEventTimelineCursor,
  parseEventListCursor,
  parseEventTimelineCursor,
} from "./event-cursor";

describe("event cursor helpers", () => {
  it("encodes and parses composite timeline cursors", () => {
    const encoded = encodeEventTimelineCursor({
      kind: "timeline",
      createdAt: 5000,
      id: "token:msg-1",
    });

    expect(encoded).toBe("5000:token%3Amsg-1");
    expect(parseEventTimelineCursor(encoded)).toEqual({
      ok: true,
      cursor: { kind: "timeline", createdAt: 5000, id: "token:msg-1" },
    });
  });

  it("allows legacy timestamp cursors only on event lists", () => {
    expect(parseEventListCursor("5000")).toEqual({
      ok: true,
      cursor: { kind: "legacy", createdAt: 5000 },
    });
    expect(parseEventTimelineCursor("5000")).toEqual({
      ok: false,
      error: "Invalid cursor",
    });
  });

  it("rejects malformed cursors", () => {
    expect(parseEventListCursor("bad")).toEqual({ ok: false, error: "Invalid cursor" });
    expect(parseEventTimelineCursor("5000:")).toEqual({
      ok: false,
      error: "Invalid cursor",
    });
  });
});
