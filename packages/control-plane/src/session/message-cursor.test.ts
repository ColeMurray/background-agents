import { describe, expect, it } from "vitest";
import { parseMessageListCursor } from "./message-cursor";

describe("message list cursors", () => {
  it("parses composite cursors and legacy timestamp cursors", () => {
    expect(parseMessageListCursor("1000:message%2Fone")).toEqual({
      ok: true,
      cursor: { createdAt: 1_000, id: "message/one" },
    });
    expect(parseMessageListCursor("1000")).toEqual({
      ok: true,
      cursor: { createdAt: 1_000 },
    });
  });

  it.each(["", "invalid", "-1", "1000:"])("rejects malformed cursor %s", (raw) => {
    expect(parseMessageListCursor(raw)).toEqual({ ok: false, error: "Invalid cursor" });
  });
});
