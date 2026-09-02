import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import type { SessionInboxItem, SessionListItem } from "@open-inspect/shared/types/session-inbox";
import type { SessionReadState } from "@open-inspect/shared/types/sessions";
import {
  applySessionReadOverlay,
  applySessionReadResult,
  findLatestTerminalMessageId,
  getSessionReadOverlay,
  isSessionMessageRead,
  pruneSessionReadOverlay,
  readStateSupersedes,
  resetSessionReadOverlay,
  scopeSessionReadOverlay,
  subscribeSessionReadOverlay,
} from "./session-read-state";

function session(id: string, readState: SessionReadState): SessionListItem {
  return {
    id,
    title: id,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    environmentId: null,
    createdAt: 1,
    updatedAt: 2,
    readState,
  };
}

const unreadFirst: SessionReadState = { latestMessageId: "message-1", unread: true, version: 1 };
const readFirst: SessionReadState = { latestMessageId: "message-1", unread: false, version: 1 };
const unreadSecond: SessionReadState = { latestMessageId: "message-2", unread: true, version: 2 };

const noRevalidate = vi.fn(async (_key: unknown) => []);

afterEach(() => {
  resetSessionReadOverlay();
  noRevalidate.mockClear();
});

describe("findLatestTerminalMessageId", () => {
  it("returns the last completed message", () => {
    const events: SandboxEvent[] = [
      {
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: "s",
        timestamp: 1,
      },
      { type: "token", messageId: "message-2", content: "working", sandboxId: "s", timestamp: 2 },
      {
        type: "execution_complete",
        messageId: "message-2",
        success: false,
        sandboxId: "s",
        timestamp: 3,
      },
    ];
    expect(findLatestTerminalMessageId(events)).toBe("message-2");
    expect(findLatestTerminalMessageId([])).toBeNull();
  });
});

describe("readStateSupersedes", () => {
  it("orders by version and keeps read final within a version", () => {
    const olderUnread = { latestMessageId: "message-1", unread: true, version: 1 } as const;
    const olderRead = { latestMessageId: "message-1", unread: false, version: 1 } as const;
    const newerUnread = { latestMessageId: "message-2", unread: true, version: 2 } as const;

    expect(readStateSupersedes(newerUnread, olderRead)).toBe(true);
    expect(readStateSupersedes(olderRead, newerUnread)).toBe(false);
    expect(readStateSupersedes(olderRead, olderUnread)).toBe(true);
    expect(readStateSupersedes(olderUnread, olderRead)).toBe(false);
    expect(readStateSupersedes(olderRead, olderRead)).toBe(true);
  });

  it("orders messages that share a version by ID, as the projection does", () => {
    const firstRead = { latestMessageId: "message-a", unread: false, version: 5 } as const;
    const secondUnread = { latestMessageId: "message-b", unread: true, version: 5 } as const;

    expect(readStateSupersedes(secondUnread, firstRead)).toBe(true);
    expect(readStateSupersedes(firstRead, secondUnread)).toBe(false);
  });
});

describe("applySessionReadResult", () => {
  it("records the server's decision and refetches the inbox only for a new read", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionReadOverlay(listener);

    await applySessionReadResult(
      {
        sessionId: "session-1",
        outcome: "already_read",
        unread: false,
        latestMessageId: "message-1",
        version: 1,
      },
      noRevalidate
    );
    expect(getSessionReadOverlay().get("session-1")).toEqual(readFirst);
    expect(noRevalidate).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    await applySessionReadResult(
      {
        sessionId: "session-2",
        outcome: "marked_read",
        unread: false,
        latestMessageId: "message-1",
        version: 1,
      },
      noRevalidate
    );
    expect(noRevalidate).toHaveBeenCalledTimes(1);
    expect(typeof noRevalidate.mock.calls[0]?.[0]).toBe("function");
    unsubscribe();
  });

  it("keeps the newest state per session and ignores repeats", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionReadOverlay(listener);

    await applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate
    );
    await applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate
    );
    expect(getSessionReadOverlay().get("session-1")).toEqual(unreadSecond);

    await applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate
    );
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("answers whether this page already read a message", async () => {
    expect(isSessionMessageRead("session-1", "message-1")).toBe(false);
    await applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate
    );
    expect(isSessionMessageRead("session-1", "message-1")).toBe(true);
    expect(isSessionMessageRead("session-1", "message-2")).toBe(false);

    await applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate
    );
    expect(isSessionMessageRead("session-1", "message-1")).toBe(false);
  });

  it("forgets reads when the viewer changes", async () => {
    scopeSessionReadOverlay("user-a");
    await applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate
    );

    scopeSessionReadOverlay("user-a");
    expect(getSessionReadOverlay().size).toBe(1);
    scopeSessionReadOverlay(null);
    expect(getSessionReadOverlay().size).toBe(0);
  });
});

describe("applySessionReadOverlay", () => {
  const item: SessionInboxItem = {
    rootSession: session("root", unreadFirst),
    descendantSessions: [session("child", unreadFirst), session("other", unreadFirst)],
  };

  it("merges a superseding entry into root and descendant rows", () => {
    const overlay = new Map([
      ["root", readFirst],
      ["child", unreadSecond],
    ]);

    const merged = applySessionReadOverlay(item, overlay);

    expect(merged.rootSession.readState).toEqual(readFirst);
    expect(merged.descendantSessions[0]?.readState).toEqual(unreadSecond);
    expect(merged.descendantSessions[1]).toBe(item.descendantSessions[1]);
    expect(item.rootSession.readState).toEqual(unreadFirst);
  });

  it("does not let an older entry hide a newer fetched message", () => {
    const fetched: SessionInboxItem = { ...item, rootSession: session("root", unreadSecond) };

    const merged = applySessionReadOverlay(fetched, new Map([["root", readFirst]]));

    expect(merged.rootSession.readState).toEqual(unreadSecond);
  });

  it("returns the item untouched when the overlay is empty", () => {
    expect(applySessionReadOverlay(item, new Map())).toBe(item);
  });
});

describe("pruneSessionReadOverlay", () => {
  it("retires entries the fetched rows have caught up with", async () => {
    await applySessionReadResult(
      { sessionId: "caught-up", outcome: "marked_read", ...readFirst },
      noRevalidate
    );
    await applySessionReadResult(
      { sessionId: "still-ahead", outcome: "marked_read", ...readFirst },
      noRevalidate
    );
    await applySessionReadResult(
      { sessionId: "unlisted", outcome: "marked_read", ...readFirst },
      noRevalidate
    );

    pruneSessionReadOverlay([
      session("caught-up", readFirst),
      session("still-ahead", unreadFirst),
      session("newer", unreadSecond),
    ]);

    expect([...getSessionReadOverlay().keys()].sort()).toEqual(["still-ahead", "unlisted"]);
  });
});
