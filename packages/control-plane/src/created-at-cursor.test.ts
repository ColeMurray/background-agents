import { describe, expect, it } from "vitest";
import { encodeCreatedAtCursor, parseCreatedAtCursor } from "./created-at-cursor";

describe("created-at cursors", () => {
  it("round-trips timestamp and encoded id values", () => {
    const encoded = encodeCreatedAtCursor({ createdAt: 123, id: "item:encoded/id" });

    expect(parseCreatedAtCursor(encoded)).toEqual({
      ok: true,
      cursor: { createdAt: 123, id: "item:encoded/id" },
    });
  });

  it.each(["invalid", "-1:item", "1e3:item", "0x10:item", "1:", "1:%E0%A4%A"])(
    "rejects malformed cursor %s",
    (raw) => {
      expect(parseCreatedAtCursor(raw)).toEqual({ ok: false, error: "Invalid cursor" });
    }
  );
});
