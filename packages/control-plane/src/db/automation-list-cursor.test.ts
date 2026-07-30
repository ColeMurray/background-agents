import { describe, expect, it } from "vitest";
import { encodeAutomationListCursor, parseAutomationListCursor } from "./automation-list-cursor";

describe("automation list cursors", () => {
  it("round-trips timestamp and encoded id values", () => {
    const encoded = encodeAutomationListCursor({ createdAt: 123, id: "auto:encoded/id" });

    expect(parseAutomationListCursor(encoded)).toEqual({
      ok: true,
      cursor: { createdAt: 123, id: "auto:encoded/id" },
    });
  });

  it.each(["invalid", "-1:auto", "1:", "1:%E0%A4%A"])("rejects malformed cursor %s", (raw) => {
    expect(parseAutomationListCursor(raw)).toEqual({ ok: false, error: "Invalid cursor" });
  });
});
