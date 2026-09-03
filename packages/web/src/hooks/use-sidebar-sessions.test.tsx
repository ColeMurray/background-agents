// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type {
  SessionInboxItem,
  SessionInboxPage,
  SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";
import type { SessionReadResult } from "@open-inspect/shared/types/sessions";
import { useSidebarSessions } from "./use-sidebar-sessions";
import {
  applySessionReadResult,
  isSessionMessageRead,
  resetSessionReadOverlay,
} from "@/lib/session-read-state";

const defaultUser = { id: "github:123", name: "Test User" };
let authUser: typeof defaultUser | null = defaultUser;
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: authUser ? { user: authUser } : undefined }),
}));

function readResult(
  sessionId: string,
  outcome: SessionReadResult["outcome"] = "marked_read"
): SessionReadResult {
  return outcome === "no_terminal_message"
    ? { sessionId, outcome, unread: false, latestMessageId: null, version: 0 }
    : { sessionId, outcome, unread: false, latestMessageId: "msg-1", version: 1 };
}
const markLatestMessageRead = vi.fn(async (sessionId: string) => readResult(sessionId));
vi.mock("@/lib/session-read-state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markLatestMessageRead: (sessionId: string) => markLatestMessageRead(sessionId),
}));

// Rows are unread by default so they qualify for attention; read state is
// what these tests change, so it is explicit where it matters.
function item(id: string): SessionInboxItem {
  return {
    rootSession: {
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
      readState: { latestMessageId: "msg-1", version: 1, unread: true },
    },
    descendantSessions: [],
  };
}

function readItem(id: string): SessionInboxItem {
  const base = item(id);
  return {
    ...base,
    rootSession: {
      ...base.rootSession,
      readState: { latestMessageId: "msg-1", version: 1, unread: false },
    },
  };
}

const noRevalidate = async () => [];
/** A read the session page recorded for the signed-in viewer. */
function recordPageRead(result: SessionReadResult) {
  applySessionReadResult(result, noRevalidate, defaultUser.id);
}

function page(ids: string[], nextCursor: string | null = null): SessionInboxPage {
  return { items: ids.map(item), hasMore: nextCursor !== null, nextCursor };
}

function snapshot(
  overrides: Partial<SessionInboxSnapshot["categories"]> = {}
): SessionInboxSnapshot {
  return {
    categories: {
      needs_attention: page(["attention"]),
      in_progress: page(["running"]),
      finished: page(["finished"]),
      ...overrides,
    },
  };
}

function wrapper(fetcher: (key: string) => unknown, cache = new Map()) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          fetcher,
          dedupingInterval: 0,
          focusThrottleInterval: 0,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  // Vitest globals are disabled, so Testing Library never registers its own
  // afterEach cleanup — unmount explicitly or the 30s poll leaks across tests.
  cleanup();
  localStorage.clear();
  setVisibility("visible");
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSessionReadOverlay();
  authUser = defaultUser;
  markLatestMessageRead.mockReset();
  markLatestMessageRead.mockImplementation(async (sessionId: string) => readResult(sessionId));
});

describe("useSidebarSessions", () => {
  it("uses exactly one canonical request to supply all three categories", async () => {
    const fetcher = vi.fn(async () => snapshot());
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox");
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished"]);
  });

  it("polls only the canonical endpoint every 30 seconds while visible", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_key: string) => snapshot());
    renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([key]) => key === "/api/sessions/inbox")).toBe(true);
  });

  it("does not poll while hidden", async () => {
    setVisibility("hidden");
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => snapshot());
    renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("switches Mine to a separate coherent key", async () => {
    const fetcher = vi.fn(async (key: string) =>
      snapshot({ finished: page([key.includes("mine=true") ? "mine" : "all"]) })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.finished.map(({ id }) => id)).toEqual(["all"]));

    act(() => result.current.setSessionCreatorFilter("mine"));

    await waitFor(() => expect(result.current.finished.map(({ id }) => id)).toEqual(["mine"]));
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox?mine=true");
    expect(fetcher.mock.calls.some(([key]) => key.includes("category="))).toBe(false);
  });

  it("loads additional pages from the category cursor endpoint", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["attention-page-2"])
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.sectionPagination.needsAttention.loadMore());

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "attention-page-2",
      ])
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=needs_attention&cursor=next"
    );
  });

  it("sends one request when Load more is clicked twice before it renders as loading", async () => {
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) {
        paginationRequests += 1;
        return page(["page-2"]);
      }
      return snapshot({ needs_attention: page(["attention"], "next") });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.sectionPagination.needsAttention.loadMore();
      result.current.sectionPagination.needsAttention.loadMore();
    });
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    expect(paginationRequests).toBe(1);
  });

  it("keeps additional pages across unchanged and changed coherent head refreshes", async () => {
    let snapshotRequest = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return page(["old-page-2"]);
      snapshotRequest += 1;
      return snapshot({
        needs_attention: page([snapshotRequest < 3 ? "old-first" : "new-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["old-first", "old-page-2"])
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first", "old-page-2"])
    );
  });

  it("accepts an in-flight pagination response after a same-filter head refresh", async () => {
    const pendingPage = deferred<SessionInboxPage>();
    let snapshotRequest = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return pendingPage.promise;
      snapshotRequest += 1;
      return snapshot({
        needs_attention: page([snapshotRequest === 1 ? "old-first" : "new-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(true)
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first"])
    );

    await act(async () => pendingPage.resolve(page(["page-2"])));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["new-first", "page-2"]);
  });

  it("does not refetch loaded pages when the head refreshes", async () => {
    let headRequests = 0;
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) {
        paginationRequests += 1;
        return page(["page-2"]);
      }
      headRequests += 1;
      return snapshot({ needs_attention: page([`head-${headRequests}`], "next") });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("head-2"));

    expect(headRequests).toBe(2);
    expect(paginationRequests).toBe(1);
  });

  it("removes a canonical root from every retained category tail", async () => {
    let headRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) return page(["moved", "tail-only"]);
      headRequests += 1;
      return snapshot({
        needs_attention: page(["attention"], "next"),
        in_progress: page(
          headRequests === 1 ? ["running"] : headRequests === 2 ? ["moved"] : ["running-new"]
        ),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toContain("moved")
    );

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() => expect(result.current.inProgress.map(({ id }) => id)).toEqual(["moved"]));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-only"]);
    expect(
      [
        ...result.current.needsAttention,
        ...result.current.inProgress,
        ...result.current.finished,
      ].filter(({ id }) => id === "moved")
    ).toHaveLength(1);

    await act(async () => result.current.sectionPagination.needsAttention.retry());
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running-new"])
    );
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-only"]);
  });

  it("resets loaded pages when the Mine filter changes", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return page(["all-page-2"]);
      return snapshot({
        needs_attention: page([key.includes("mine=true") ? "mine-first" : "all-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    act(() => result.current.setSessionCreatorFilter("mine"));

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["mine-first"])
    );
  });

  it("discards an in-flight pagination response when the Mine filter changes", async () => {
    const pendingPage = deferred<SessionInboxPage>();
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) return pendingPage.promise;
      return snapshot({
        needs_attention: page([key.includes("mine=true") ? "mine-first" : "all-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(true)
    );

    act(() => result.current.setSessionCreatorFilter("mine"));
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("mine-first"));
    await act(async () => pendingPage.resolve(page(["all-page-2"])));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["mine-first"]);
  });

  it("renders a cross-category tail root only in its newest loaded page", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) return page(["duplicate", "attention-tail"]);
      if (key.includes("category=finished")) return page(["duplicate", "finished-tail"]);
      return snapshot({
        needs_attention: page(["attention"], "attention-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toContain("duplicate")
    );

    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() =>
      expect(result.current.finished.map(({ id }) => id)).toContain("finished-tail")
    );

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
      "attention",
      "attention-tail",
    ]);
    expect(result.current.finished.map(({ id }) => id)).toEqual([
      "finished",
      "duplicate",
      "finished-tail",
    ]);
  });

  it("retries a failed pagination request", async () => {
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (!key.includes("category=")) {
        return snapshot({ needs_attention: page(["attention"], "next") });
      }
      paginationRequests += 1;
      if (paginationRequests === 1) throw new Error("pagination failed");
      return page(["recovered-page-2"]);
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sessionsError).toEqual(new Error("pagination failed"))
    );
    await act(async () => result.current.sectionPagination.needsAttention.retry());

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "attention",
        "recovered-page-2",
      ])
    );
    expect(paginationRequests).toBe(2);
  });

  it("removes an archived session from retained pages", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["tail-a", "tail-b"])
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(3));

    await act(async () => result.current.handleSessionArchived("tail-a"));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-b"]);
  });

  it("hides a fully read hierarchy from attention and lets the refetched snapshot place it", async () => {
    const refetchedSnapshot = deferred<SessionInboxSnapshot>();
    let headRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category="))
        return { items: [item("tail-read"), item("tail-other")], hasMore: false, nextCursor: null };
      headRequests += 1;
      if (headRequests === 1) return snapshot({ needs_attention: page(["attention"], "next") });
      return refetchedSnapshot.promise;
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(3));

    const marked = act(async () => result.current.handleMarkLatestMessageRead("tail-read"));
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-other"])
    );
    // Nothing on the client moved the session: it is absent until the server places it.
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(
      result.current.needsAttention.find(({ id }) => id === "tail-other")?.readState.unread
    ).toBe(true);
    expect(headRequests).toBe(2);

    refetchedSnapshot.resolve(
      snapshot({
        needs_attention: page(["attention"], "next"),
        in_progress: {
          items: [readItem("tail-read"), item("running")],
          hasMore: false,
          nextCursor: null,
        },
      })
    );
    await marked;
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["tail-read", "running"])
    );
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-other"]);
  });

  it("hides a read head row from attention until the server places it", async () => {
    const fetcher = vi.fn(async () => snapshot({ needs_attention: page(["attention", "other"]) }));
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => recordPageRead(readResult("attention")));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["other"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
  });

  it("does not refetch when the server reports the session was already read", async () => {
    markLatestMessageRead.mockImplementation(async (sessionId: string) =>
      readResult(sessionId, "already_read")
    );
    let snapshotFetches = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=finished")) {
        return {
          items: [readItem("finished-tail-a"), readItem("finished-tail-b")],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (key.includes("category=in_progress")) return page(["progress-tail"]);
      snapshotFetches += 1;
      return snapshot({
        in_progress: page(["running"], "progress-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(3));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));
    const fetchesBefore = snapshotFetches;

    // Opening a session acknowledges its terminal message even when it is
    // already read. Nothing changed, so nothing in the sidebar should move.
    await act(async () => result.current.handleMarkLatestMessageRead("finished-tail-b"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.finished.map(({ id }) => id)).toEqual([
      "finished",
      "finished-tail-a",
      "finished-tail-b",
    ]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running", "progress-tail"]);
    expect(snapshotFetches).toBe(fetchesBefore);
  });

  it("shows a newer unread message from a not_latest result and refetches the snapshot", async () => {
    markLatestMessageRead.mockImplementation(async (sessionId: string) => ({
      sessionId,
      outcome: "not_latest",
      latestMessageId: "msg-9",
      version: 9,
      unread: true,
    }));
    let snapshotFetches = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) {
        return { items: [readItem("finished-tail")], hasMore: false, nextCursor: null };
      }
      snapshotFetches += 1;
      return snapshot({ finished: page(["finished"], "finished-next") });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));
    const fetchesBefore = snapshotFetches;

    await act(async () => result.current.handleMarkLatestMessageRead("finished-tail"));

    const tail = result.current.finished.find(({ id }) => id === "finished-tail");
    expect(tail?.readState).toEqual({ latestMessageId: "msg-9", version: 9, unread: true });
    // The server owns placement: a newer unread message means a refetch, so
    // the row can move to attention where the inbox query puts it.
    await waitFor(() => expect(snapshotFetches).toBe(fetchesBefore + 1));
  });

  it("shows a read on a loaded page row without dropping it", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [item("finished-tail")], hasMore: false, nextCursor: null }
        : snapshot({ finished: page(["finished"], "finished-next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(async () => result.current.handleMarkLatestMessageRead("finished-tail"));

    const tail = result.current.finished.find(({ id }) => id === "finished-tail");
    expect(tail?.readState).toEqual({ latestMessageId: "msg-1", version: 1, unread: false });
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-tail"]);
  });

  it("does not let a read recorded earlier hide a newer fetched message", async () => {
    const fetcher = vi.fn(async () =>
      snapshot({
        needs_attention: {
          items: [
            {
              ...item("attention"),
              rootSession: {
                ...item("attention").rootSession,
                readState: { latestMessageId: "msg-2", version: 2, unread: true },
              },
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
      })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => recordPageRead(readResult("attention")));

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.needsAttention[0]?.readState.unread).toBe(true);
  });

  it("keeps a recorded read once the fetched row catches up, so reopening need not ask", async () => {
    let sessionRead = false;
    const fetcher = vi.fn(async () =>
      sessionRead
        ? snapshot({
            needs_attention: page([]),
            in_progress: {
              items: [readItem("target"), item("running")],
              hasMore: false,
              nextCursor: null,
            },
          })
        : snapshot({ needs_attention: page(["target"]) })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => recordPageRead(readResult("target")));
    expect(result.current.needsAttention).toEqual([]);

    sessionRead = true;
    await act(async () => result.current.refreshSnapshot());

    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["target", "running"])
    );
    expect(result.current.inProgress[0]?.readState.unread).toBe(false);
    expect(isSessionMessageRead(defaultUser.id, "target", "msg-1")).toBe(true);
  });

  it("does not render another viewer's reads", async () => {
    const fetcher = vi.fn(async () => snapshot());
    const { result, rerender } = renderHook(() => useSidebarSessions(), {
      wrapper: wrapper(fetcher),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => recordPageRead(readResult("attention")));
    expect(result.current.needsAttention).toEqual([]);

    authUser = { id: "github:456", name: "Other User" };
    rerender();

    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"])
    );
    expect(result.current.needsAttention[0]?.readState.unread).toBe(true);
  });

  it("discards loaded pages when the head boundary moves", async () => {
    let sessionRead = false;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=in_progress")) {
        return page([
          key.includes("new-progress-next") ? "new-progress-tail" : "old-progress-tail",
        ]);
      }
      if (key.includes("category=")) return page(["attention-tail"]);
      return sessionRead
        ? snapshot({
            needs_attention: page(["attention"], "attention-next"),
            in_progress: {
              items: [readItem("moving"), item("running")],
              hasMore: true,
              nextCursor: "new-progress-next",
            },
          })
        : snapshot({
            needs_attention: page(["attention"], "attention-next"),
            in_progress: page(["running"], "progress-next"),
          });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));

    sessionRead = true;
    await act(async () => result.current.refreshSnapshot());

    // The in-progress head gained a row, so its old tail could hide the rows
    // now below the new boundary; it is dropped. The attention chain, whose
    // boundary did not move, keeps its tail.
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["moving", "running"])
    );
    expect(result.current.sectionPagination.inProgress.hasMore).toBe(true);
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
      "attention",
      "attention-tail",
    ]);

    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual([
        "moving",
        "running",
        "new-progress-tail",
      ])
    );
  });

  it("drops a response from an earlier chain even when the filter returns to the same identity", async () => {
    const pendingPage = deferred<SessionInboxPage>();
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=")) {
        paginationRequests += 1;
        return paginationRequests === 1 ? pendingPage.promise : page(["fresh-page-2"]);
      }
      return snapshot({
        needs_attention: page([key.includes("mine=true") ? "mine-first" : "all-first"], "next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(true)
    );

    act(() => result.current.setSessionCreatorFilter("mine"));
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("mine-first"));
    act(() => result.current.setSessionCreatorFilter("all"));
    await waitFor(() => expect(result.current.needsAttention[0]?.id).toBe("all-first"));
    expect(result.current.sectionPagination.needsAttention.loadingMore).toBe(false);

    await act(async () => pendingPage.resolve(page(["stale-page-2"])));
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["all-first"]);

    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() =>
      expect(result.current.needsAttention.map(({ id }) => id)).toEqual([
        "all-first",
        "fresh-page-2",
      ])
    );
  });

  it("starts pagination from the head after a remount", async () => {
    let sessionRead = false;
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (!key.includes("category=")) {
        return snapshot({ needs_attention: page(["attention"], "next") });
      }
      paginationRequests += 1;
      return sessionRead
        ? { items: [], hasMore: false, nextCursor: null }
        : { items: [item("tail-unread")], hasMore: false, nextCursor: null };
    });
    const cache = new Map();
    const TestWrapper = wrapper(fetcher, cache);
    const first = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(first.result.current.needsAttention).toHaveLength(2));

    sessionRead = true;
    await act(async () => first.result.current.handleMarkLatestMessageRead("tail-unread"));
    first.unmount();

    const second = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect([...cache.keys()].every((key) => typeof key === "string")).toBe(true);
    act(() => second.result.current.sectionPagination.needsAttention.loadMore());

    await waitFor(() => expect(paginationRequests).toBe(2));
    await waitFor(() =>
      expect(second.result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"])
    );
  });
});
