import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@open-inspect/shared/types/session-inbox";
import {
  applySessionInboxReadStateUpdate,
  buildSessionInboxKey,
  isSessionInboxKey,
  isSessionInboxPaginationKey,
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

  it("matches cached pagination tuple keys", () => {
    expect(
      isSessionInboxPaginationKey([
        "/api/sessions/inbox?category=needs_attention&cursor=next",
        '["user-1",false]',
      ])
    ).toBe(true);
    expect(isSessionInboxPaginationKey(["/api/sessions?status=active", "filter"])).toBe(false);
  });
});

describe("applySessionInboxReadStateUpdate", () => {
  const readState = { latestMessageId: "old-message", version: 1, unread: false } as const;

  it("updates a matching root session in a page without disturbing unrelated sessions", () => {
    const data: SessionInboxPage = {
      ...page("target", ["target-child"]),
      items: [...page("target", ["target-child"]).items, ...page("unrelated").items],
    };

    const result = applySessionInboxReadStateUpdate(data, "target", readState);

    expect(result?.items[0].rootSession.readState).toEqual(readState);
    expect(result?.items[0].descendantSessions[0].readState).toEqual({
      latestMessageId: "old-message",
      version: 1,
      unread: true,
    });
    expect(result?.items[1].rootSession.readState).toEqual({
      latestMessageId: "old-message",
      version: 1,
      unread: true,
    });
    expect(data.items[0].rootSession.readState.unread).toBe(true);
  });

  it("updates a matching descendant in a snapshot without disturbing other sessions", () => {
    const data: SessionInboxSnapshot = {
      categories: {
        needs_attention: page("attention-root", ["target-child", "sibling-child"]),
        in_progress: page("progress-root", ["progress-child"]),
        finished: page("finished-root"),
      },
    };

    const result = applySessionInboxReadStateUpdate(data, "target-child", readState);

    expect(result?.categories.needs_attention.items[0].descendantSessions[0].readState).toEqual(
      readState
    );
    expect(result?.categories.needs_attention.items[0].rootSession.readState.unread).toBe(true);
    expect(result?.categories.needs_attention.items[0].descendantSessions[1].readState.unread).toBe(
      true
    );
    expect(result?.categories.in_progress.items[0].rootSession.readState.unread).toBe(true);
    expect(data.categories.needs_attention.items[0].descendantSessions[0].readState.unread).toBe(
      true
    );
  });

  it("moves a fully read active hierarchy from attention to in progress", () => {
    const data: SessionInboxSnapshot = {
      categories: {
        needs_attention: page("target"),
        in_progress: page("progress-root"),
        finished: page("finished-root"),
      },
    };

    const result = applySessionInboxReadStateUpdate(data, "target", readState);

    expect(result?.categories.needs_attention.items).toEqual([]);
    expect(result?.categories.in_progress.items.map((item) => item.rootSession.id)).toEqual([
      "target",
      "progress-root",
    ]);
  });

  it("moves a fully read finished descendant hierarchy from attention to finished", () => {
    const attentionPage = page("target-root", ["target-child"]);
    attentionPage.items[0].rootSession.status = "completed";
    attentionPage.items[0].rootSession.readState.unread = false;
    attentionPage.items[0].descendantSessions[0].status = "completed";
    const data: SessionInboxSnapshot = {
      categories: {
        needs_attention: attentionPage,
        in_progress: page("progress-root"),
        finished: page("finished-root"),
      },
    };

    const result = applySessionInboxReadStateUpdate(data, "target-child", readState);

    expect(result?.categories.needs_attention.items).toEqual([]);
    expect(result?.categories.finished.items.map((item) => item.rootSession.id)).toEqual([
      "target-root",
      "finished-root",
    ]);
  });

  it("does not let an older result overwrite a newer cached terminal message", () => {
    const data = page("target");
    data.items[0].rootSession.readState = {
      latestMessageId: "newer-message",
      version: 2,
      unread: true,
    };

    const result = applySessionInboxReadStateUpdate(data, "target", readState);

    expect(result?.items[0].rootSession.readState).toEqual({
      latestMessageId: "newer-message",
      version: 2,
      unread: true,
    });
  });
});
