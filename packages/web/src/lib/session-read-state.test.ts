import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import type { SessionInboxItem, SessionListItem } from "@open-inspect/shared/types/session-inbox";
import type { SessionReadState } from "@open-inspect/shared/types/sessions";
import {
  applySessionReadOverlay,
  applySessionReadResult,
  findLatestTerminalMessageId,
  getSessionReadOverlay,
  getSessionReadSnapshot,
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
  it("returns a stable empty snapshot and restores it on reset", () => {
    const empty = getSessionReadSnapshot(null);
    expect(empty).toEqual({ overlay: new Map(), inboxRevision: 0 });
    expect(getSessionReadSnapshot(VIEWER)).toBe(empty);
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      VIEWER
    );
    resetSessionReadOverlay();
    expect(getSessionReadSnapshot(VIEWER)).toBe(empty);
  });

  it.each(["marked_read", "not_latest"] as const)(
    "publishes overlay and revision atomically for repeated %s results",
    (outcome) => {
      const readState = outcome === "marked_read" ? readFirst : unreadSecond;
      const result = { sessionId: "session-1", outcome, ...readState };
      const listener = vi.fn(() => getSessionReadSnapshot(VIEWER));
      const unsubscribe = subscribeSessionReadOverlay(listener);
      try {
        applySessionReadResult(result, noRevalidate, VIEWER);
        const first = getSessionReadSnapshot(VIEWER);
        expect(first.inboxRevision).toBe(1);
        expect(first.overlay.get("session-1")).toEqual(readState);
        expect(getSessionReadOverlay(VIEWER)).toBe(first.overlay);
        expect(getSessionReadSnapshot(VIEWER)).toBe(first);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.results[0]?.value).toBe(first);

        applySessionReadResult(result, noRevalidate, VIEWER);
        const second = getSessionReadSnapshot(VIEWER);
        expect(second).not.toBe(first);
        expect(second.overlay).toBe(first.overlay);
        expect(second.inboxRevision).toBe(2);
        expect(first.inboxRevision).toBe(1);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.results[1]?.value).toBe(second);
        expect(noRevalidate).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
      }
    }
  );

  it.each(["already_read", "no_terminal_message"] as const)(
    "does not invalidate the inbox for %s or publish identical repeats",
    (outcome) => {
      const readState =
        outcome === "already_read"
          ? readFirst
          : ({ latestMessageId: null, unread: false, version: 0 } as const);
      const result =
        outcome === "already_read"
          ? { sessionId: "session-1", outcome, ...readFirst }
          : {
              sessionId: "session-1",
              outcome,
              latestMessageId: null,
              unread: false as const,
              version: 0,
            };
      const listener = vi.fn();
      const unsubscribe = subscribeSessionReadOverlay(listener);
      try {
        applySessionReadResult(result, noRevalidate, VIEWER);
        const snapshot = getSessionReadSnapshot(VIEWER);
        expect(snapshot.inboxRevision).toBe(0);
        expect(snapshot.overlay.get("session-1")).toEqual(readState);
        applySessionReadResult(result, noRevalidate, VIEWER);
        expect(getSessionReadSnapshot(VIEWER)).toBe(snapshot);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(noRevalidate).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    }
  );

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
    const viewerSnapshot = getSessionReadSnapshot(VIEWER);
    applySessionReadResult(
      { sessionId: "session-1", outcome: "marked_read", ...readFirst },
      noRevalidate,
      "viewer-b"
    );

    expect(getSessionReadOverlay(VIEWER).size).toBe(0);
    expect(getSessionReadOverlay("viewer-b").get("session-1")).toEqual(readFirst);
    expect(getSessionReadOverlay(null).size).toBe(0);
    expect(getSessionReadSnapshot(VIEWER)).toBe(viewerSnapshot);
    expect(getSessionReadSnapshot("viewer-b").inboxRevision).toBe(1);
    expect(getSessionReadSnapshot(null).inboxRevision).toBe(0);
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
    expect(getSessionReadSnapshot(VIEWER).inboxRevision).toBe(1);
  });

  it("keeps the newest overlay while invalidating for stale and repeated results", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionReadOverlay(listener);

    applySessionReadResult(
      { sessionId: "session-1", outcome: "not_latest", ...unreadSecond },
      noRevalidate,
      VIEWER
    );
    const overlay = getSessionReadOverlay(VIEWER);
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
    expect(getSessionReadOverlay(VIEWER)).toBe(overlay);
    expect(getSessionReadSnapshot(VIEWER).inboxRevision).toBe(3);
    expect(listener).toHaveBeenCalledTimes(3);
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
