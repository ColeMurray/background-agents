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
import { useSidebarSessions } from "./use-sidebar-sessions";
import { reconcileSessionReadState } from "@/lib/session-read-state";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "github:123", name: "Test User" } } }),
}));

vi.mock("@/lib/session-read-state", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    markLatestMessageRead: async (sessionId: string) => ({
      sessionId,
      outcome: "marked_read" as const,
      unread: false,
      latestMessageId: "msg-1",
      version: 1,
    }),
  };
});

function item(id: string) {
  return {
    rootSession: {
      id,
      title: id,
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      status: "active" as const,
      parentSessionId: null,
      spawnSource: "user" as const,
      environmentId: null,
      createdAt: 1,
      updatedAt: 2,
      readState: { latestMessageId: null, version: 0, unread: false as const },
    },
    descendantSessions: [],
  };
}

function unreadItem(id: string): SessionInboxItem {
  const base = item(id);
  return {
    ...base,
    rootSession: {
      ...base.rootSession,
      readState: { latestMessageId: "msg-1", version: 1, unread: true },
    },
  };
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

  it("reconciles read state on retained pages when a session is marked read", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? {
            items: [unreadItem("tail-unread"), unreadItem("tail-other")],
            hasMore: false,
            nextCursor: null,
          }
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(3));

    await act(async () => result.current.handleMarkLatestMessageRead("tail-unread"));

    // The freshly read hierarchy leaves the retained attention page; the still
    // unread one stays with its read state intact.
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention", "tail-other"]);
    const remainingTail = result.current.needsAttention.find(({ id }) => id === "tail-other");
    expect(remainingTail?.readState.unread).toBe(true);
  });

  it("keeps retained pages when an already-read session is acknowledged", async () => {
    let snapshotFetches = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=finished")) return page(["finished-tail-a", "finished-tail-b"]);
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
    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail-b",
        outcome: "already_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(result.current.finished.map(({ id }) => id)).toEqual([
      "finished",
      "finished-tail-a",
      "finished-tail-b",
    ]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running", "progress-tail"]);
    expect(snapshotFetches).toBe(fetchesBefore);
  });

  it("keeps retained pages for a not_latest result", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? page(["finished-tail"])
        : snapshot({ finished: page(["finished"], "finished-next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail",
        outcome: "not_latest",
        latestMessageId: "msg-9",
        version: 9,
        unread: true,
      })
    );

    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-tail"]);
  });

  it("updates a read tail row in place instead of dropping it", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [unreadItem("finished-tail")], hasMore: false, nextCursor: null }
        : snapshot({ finished: page(["finished"], "finished-next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "finished-tail",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    const tail = result.current.finished.find(({ id }) => id === "finished-tail");
    expect(tail?.readState).toEqual({ latestMessageId: "msg-1", version: 1, unread: false });
  });

  it("resets only the destination chain when an attention tail leaves attention", async () => {
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) {
        return { items: [unreadItem("moving")], hasMore: false, nextCursor: null };
      }
      if (key.includes("category=in_progress")) return page(["progress-tail"]);
      if (key.includes("category=finished")) return page(["finished-tail"]);
      return snapshot({
        needs_attention: page(["attention"], "attention-next"),
        in_progress: page(["running"], "progress-next"),
        finished: page(["finished"], "finished-next"),
      });
    });
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    act(() => result.current.sectionPagination.inProgress.loadMore());
    act(() => result.current.sectionPagination.finished.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));
    await waitFor(() => expect(result.current.inProgress).toHaveLength(2));
    await waitFor(() => expect(result.current.finished).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "moving",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    // "moving" is active, so it heads for in_progress: that chain restarts from
    // the head page. The finished chain is unaffected and keeps its tail.
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
    expect(result.current.inProgress.map(({ id }) => id)).toEqual(["running"]);
    expect(result.current.finished.map(({ id }) => id)).toEqual(["finished", "finished-tail"]);
  });

  it("reconciles retained pages when read state changes outside the sidebar", async () => {
    const fetcher = vi.fn(async (key: string) =>
      key.includes("category=")
        ? { items: [unreadItem("tail-unread")], hasMore: false, nextCursor: null }
        : snapshot({ needs_attention: page(["attention"], "next") })
    );
    const { result } = renderHook(() => useSidebarSessions(), { wrapper: wrapper(fetcher) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(result.current.needsAttention).toHaveLength(2));

    await act(() =>
      reconcileSessionReadState({
        sessionId: "tail-unread",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );

    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);
  });

  it("resets destination pagination when an attention tail changes category", async () => {
    let sessionRead = false;
    const fetcher = vi.fn(async (key: string) => {
      if (key.includes("category=needs_attention")) {
        return { items: [unreadItem("moving")], hasMore: false, nextCursor: null };
      }
      if (key.includes("category=in_progress")) {
        return page([
          key.includes("new-progress-next") ? "new-progress-tail" : "old-progress-tail",
        ]);
      }
      return sessionRead
        ? snapshot({
            needs_attention: page(["attention"]),
            in_progress: page(["moving", "running"], "new-progress-next"),
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
    await act(() =>
      reconcileSessionReadState({
        sessionId: "moving",
        outcome: "marked_read",
        latestMessageId: "msg-2",
        version: 2,
        unread: false,
      })
    );

    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual(["moving", "running"])
    );
    expect(result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"]);

    act(() => result.current.sectionPagination.inProgress.loadMore());
    await waitFor(() =>
      expect(result.current.inProgress.map(({ id }) => id)).toEqual([
        "moving",
        "running",
        "new-progress-tail",
      ])
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/sessions/inbox?category=in_progress&cursor=new-progress-next"
    );
  });

  it("invalidates cached pagination before a remount can restore stale unread state", async () => {
    let sessionRead = false;
    let paginationRequests = 0;
    const fetcher = vi.fn(async (key: string) => {
      if (!key.includes("category=")) {
        return snapshot({ needs_attention: page(["attention"], "next") });
      }
      paginationRequests += 1;
      return sessionRead
        ? { items: [], hasMore: false, nextCursor: null }
        : { items: [unreadItem("tail-unread")], hasMore: false, nextCursor: null };
    });
    const cache = new Map();
    const TestWrapper = wrapper(fetcher, cache);
    const first = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => first.result.current.sectionPagination.needsAttention.loadMore());
    await waitFor(() => expect(first.result.current.needsAttention).toHaveLength(2));

    sessionRead = true;
    await act(() =>
      reconcileSessionReadState({
        sessionId: "tail-unread",
        outcome: "marked_read",
        latestMessageId: "msg-1",
        version: 1,
        unread: false,
      })
    );
    first.unmount();

    const second = renderHook(() => useSidebarSessions(), { wrapper: TestWrapper });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    act(() => second.result.current.sectionPagination.needsAttention.loadMore());

    await waitFor(() => expect(paginationRequests).toBe(2));
    await waitFor(() =>
      expect(second.result.current.needsAttention.map(({ id }) => id)).toEqual(["attention"])
    );
  });
});
