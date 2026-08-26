import { describe, expect, it } from "vitest";
import { buildSessionInboxKey, isSessionInboxKey } from "./session-inbox-api";

describe("session inbox API keys", () => {
  it("builds canonical category cursor keys", () => {
    expect(
      buildSessionInboxKey({
        category: "needs_attention",
        cursor: "next-page",
        mine: true,
      })
    ).toBe("/api/sessions/inbox?category=needs_attention&cursor=next-page&mine=true");
  });

  it.each([
    "/api/sessions/inbox",
    "/api/sessions/inbox?mine=true",
    "/api/sessions/inbox?category=finished",
  ])("matches the inbox resource %s", (key) => {
    expect(isSessionInboxKey(key)).toBe(true);
  });

  it.each([
    "/api/sessions?status=active",
    "/api/sessions/inbox-other",
    "/api/sessions/inboxes",
    "/api/sessions/inbox/snapshot",
    "/api/sessions/inbox/revision",
    "/api/sessions/inbox/revisions",
    42,
    null,
  ])("does not match unrelated key %s", (key) => {
    expect(isSessionInboxKey(key)).toBe(false);
  });
});
