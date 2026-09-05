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
  readStateSupersedes,
  resetSessionReadOverlay,
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

const VIEWER = "viewer-a";

afterEach(() => {
  resetSessionReadOverlay();
  noRevalidate.mockClear();
  vi.restoreAllMocks();
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
  it("records the server's decision and refetches the inbox when placement can change", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionReadOverlay(listener);

    applySessionReadResult(
      {
        sessionId: "session-1",
        outcome: "already_read",
        unread: false,
        latestMessageId: "message-1",
        version: 1,
      },
      noRevalidate,
      VIEWER
    );
    expect(getSessionReadOverlay(VIEWER).get("session-1")).toEqual(readFirst);
    expect(noRevalidate).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    applySessionReadResult(
      {
        sessionId: "session-2",
        outcome: "marked_read",
        unread: false,
        latestMessageId: "message-1",
        version: 1,
      },
      noRevalidate,
      VIEWER
    );
    expect(noRevalidate).toHaveBeenCalledTimes(1);
    expect(typeof noRevalidate.mock.calls[0]?.[0]).toBe("function");

    applySessionReadResult(
      { sessionId: "session-3", outcome: "not_latest", ...unreadSecond },
      noRevalidate,
      VIEWER
    );
    expect(noRevalidate).toHaveBeenCalledTimes(2);

    applySessionReadResult(
      {
        sessionId: "session-4",
        outcome: "no_terminal_message",
        unread: false,
        latestMessageId: null,
        version: 0,
      },
      noRevalidate,
      VIEWER
    );
    expect(noRevalidate).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps each viewer's reads apart", () => {
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      "viewer-b"
    );

    expect(getSessionReadOverlay(VIEWER).size).toBe(0);
    expect(getSessionReadOverlay("viewer-b").get("session-1")).toEqual(readFirst);
    expect(getSessionReadOverlay(null).size).toBe(0);
    expect(isSessionMessageRead(VIEWER, "session-1", "message-1")).toBe(false);
    expect(isSessionMessageRead("viewer-b", "session-1", "message-1")).toBe(true);
  });

  it("settles the read even when the inbox refresh fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingRevalidate = vi.fn(async (_key: unknown) => {
      throw new Error("offline");
    });

    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      failingRevalidate,
      VIEWER
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(getSessionReadOverlay(VIEWER).get("session-1")).toEqual(readFirst);
  });

  it("keeps the newest state per session and ignores repeats", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionReadOverlay(listener);

    applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate,
      VIEWER
    );
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      VIEWER
    );
    expect(getSessionReadOverlay(VIEWER).get("session-1")).toEqual(unreadSecond);

    applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate,
      VIEWER
    );
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("answers whether this page already read a message", async () => {
    expect(isSessionMessageRead(VIEWER, "session-1", "message-1")).toBe(false);
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      VIEWER
    );
    expect(isSessionMessageRead(VIEWER, "session-1", "message-1")).toBe(true);
    expect(isSessionMessageRead(VIEWER, "session-1", "message-2")).toBe(false);

    applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate,
      VIEWER
    );
    expect(isSessionMessageRead(VIEWER, "session-1", "message-1")).toBe(false);
  });

  it("keeps a read after the fetched row catches up, so reopening need not ask", () => {
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      VIEWER
    );

    const merged = applySessionReadOverlay(
      { rootSession: session("session-1", readFirst), descendantSessions: [] },
      getSessionReadOverlay(VIEWER)
    );

    expect(merged.rootSession.readState).toEqual(readFirst);
    expect(isSessionMessageRead(VIEWER, "session-1", "message-1")).toBe(true);
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

  it("returns the item untouched when no row in it has a superseding entry", () => {
    const overlay = new Map([
      ["elsewhere", readFirst],
      ["root", { latestMessageId: "message-0", unread: false, version: 0 }],
    ]);

    expect(applySessionReadOverlay(item, overlay)).toBe(item);
  });
});
