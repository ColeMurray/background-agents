import { describe, expect, it } from "vitest";
import { publishedEntries } from "./executor";

describe("publishedEntries", () => {
  it("reads Slack conversations.replies messages for reconciliation", () => {
    expect(publishedEntries({ ok: true, messages: [{ ts: "1.2", text: "published" }] })).toEqual([
      { ts: "1.2", text: "published" },
    ]);
  });
});
