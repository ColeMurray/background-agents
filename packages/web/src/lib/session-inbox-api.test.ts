import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@open-inspect/shared/types/session-inbox";
import {
  applySessionInboxTitleUpdate,
  buildSessionInboxKey,
  isSessionInboxItemFullyRead,
  isSessionInboxKey,
  type SessionInboxPage,
  type SessionInboxSnapshot,
} from "./session-inbox-api";

function session(id: string, parentSessionId: string | null = null): SessionListItem {
  return {
    id,
    title: id,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    status: "active",
    parentSessionId,
    spawnSource: parentSessionId ? "agent" : "user",
    environmentId: null,
    createdAt: 1,
    updatedAt: 2,
    readState: { latestMessageId: "old-message", version: 1, unread: true },
  };
}

function page(rootId: string, descendantIds: string[] = []): SessionInboxPage {
  return {
    items: [
      {
        rootSession: session(rootId),
        descendantSessions: descendantIds.map((id) => session(id, rootId)),
      },
    ],
    hasMore: false,
    nextCursor: null,
  };
}

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

describe("isSessionInboxItemFullyRead", () => {
  const read = { latestMessageId: "old-message", version: 1, unread: false } as const;

  it("keeps a hierarchy in attention while any session in it is unread", () => {
    const unread = page("root", ["child"]).items[0];
    expect(isSessionInboxItemFullyRead(unread)).toBe(false);

    const rootRead = { ...unread, rootSession: { ...unread.rootSession, readState: read } };
    expect(isSessionInboxItemFullyRead(rootRead)).toBe(false);

    const allRead = {
      ...rootRead,
      descendantSessions: rootRead.descendantSessions.map((child) => ({
        ...child,
        readState: read,
      })),
    };
    expect(isSessionInboxItemFullyRead(allRead)).toBe(true);
  });
});

describe("applySessionInboxTitleUpdate", () => {
  it("renames a session in every category without disturbing other rows", () => {
    const data: SessionInboxSnapshot = {
      categories: {
        needs_attention: page("attention-root", ["target"]),
        in_progress: page("progress-root"),
        finished: page("finished-root"),
      },
    };

    const result = applySessionInboxTitleUpdate(data, "target", "Renamed");

    expect(result?.categories.needs_attention.items[0].descendantSessions[0].title).toBe("Renamed");
    expect(result?.categories.needs_attention.items[0].rootSession.title).toBe("attention-root");
    expect(result?.categories.in_progress).toEqual(data.categories.in_progress);
    expect(applySessionInboxTitleUpdate(undefined, "target", "Renamed")).toBeUndefined();
  });
});
