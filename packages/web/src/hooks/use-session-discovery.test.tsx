// @vitest-environment jsdom

import type { PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListSummary } from "@open-inspect/shared/types/sessions";
import {
  DEFAULT_SESSION_DISCOVERY_QUERY,
  type SessionDiscoveryQuery,
} from "@/lib/session-discovery";
import { useSessionDiscovery } from "./use-session-discovery";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    status: "authenticated",
    data: { user: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  }),
}));

function session(id: string): SessionListSummary {
  return {
    id,
    title: id,
    status: "completed",
    repoOwner: "acme",
    repoName: "web",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    harness: "opencode",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    automationId: null,
    automationRunId: null,
    scmLogin: null,
    userId: null,
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function wrapper({ children }: PropsWithChildren) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

function stubPages(pages: Record<string, { sessions: SessionListSummary[]; hasMore: boolean }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const key = String(input);
    const page = pages[key];
    if (!page) return Response.json({ error: `unexpected ${key}` }, { status: 500 });
    return Response.json(page);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSessionDiscovery", () => {
  it("pages with offsets that embed the full query and resets when a filter changes", async () => {
    const fetchMock = stubPages({
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&q=login": {
        sessions: [session("first")],
        hasMore: true,
      },
      "/api/sessions?limit=50&offset=50&excludeStatus=archived&q=login": {
        sessions: [session("second")],
        hasMore: false,
      },
      "/api/sessions?limit=50&offset=0&status=archived&q=login": {
        sessions: [session("archived-one")],
        hasMore: false,
      },
    });
    const searchQuery: SessionDiscoveryQuery = { ...DEFAULT_SESSION_DISCOVERY_QUERY, q: "login" };

    const { result, rerender } = renderHook(({ query }) => useSessionDiscovery(query), {
      wrapper,
      initialProps: { query: searchQuery },
    });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions.map((entry) => entry.id)).toEqual(["first"]);
    expect(result.current.hasMore).toBe(true);

    await act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.sessions.map((entry) => entry.id)).toEqual(["first", "second"])
    );
    expect(result.current.hasMore).toBe(false);

    // A lifecycle change starts over from the first page of the new query and
    // never shows the previous filter's rows.
    rerender({ query: { ...searchQuery, lifecycle: "archived" } });
    await waitFor(() =>
      expect(result.current.sessions.map((entry) => entry.id)).toEqual(["archived-one"])
    );
    // Load more also revalidates the first page (SWR's default), so a row
    // bumped since the first fetch is not shown stale next to the new page.
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&q=login",
      "/api/sessions?limit=50&offset=0&excludeStatus=archived&q=login",
      "/api/sessions?limit=50&offset=50&excludeStatus=archived&q=login",
      "/api/sessions?limit=50&offset=0&status=archived&q=login",
    ]);
  });

  it("requests nothing while disabled and reads as an empty, settled result", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => useSessionDiscovery(DEFAULT_SESSION_DISCOVERY_QUERY, { enabled: false }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a row the server handed to two offset pages", async () => {
    stubPages({
      "/api/sessions?limit=50&offset=0&excludeStatus=archived": {
        sessions: [session("a"), session("b")],
        hasMore: true,
      },
      "/api/sessions?limit=50&offset=50&excludeStatus=archived": {
        sessions: [session("b"), session("c")],
        hasMore: false,
      },
    });

    const { result } = renderHook(() => useSessionDiscovery(DEFAULT_SESSION_DISCOVERY_QUERY), {
      wrapper,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.loadMore());

    await waitFor(() =>
      expect(result.current.sessions.map((entry) => entry.id)).toEqual(["a", "b", "c"])
    );
  });

  it("revalidates the first page on remount so edits made elsewhere appear", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sessions: [session("v1")], hasMore: false }))
      .mockResolvedValueOnce(Response.json({ sessions: [session("v2")], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    const cache = new Map();
    const sharedWrapper = ({ children }: PropsWithChildren) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );

    const first = renderHook(() => useSessionDiscovery(DEFAULT_SESSION_DISCOVERY_QUERY), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(first.result.current.sessions.map((s) => s.id)).toEqual(["v1"]));
    first.unmount();

    const second = renderHook(() => useSessionDiscovery(DEFAULT_SESSION_DISCOVERY_QUERY), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(second.result.current.sessions.map((s) => s.id)).toEqual(["v2"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a failed page as an error that retry can clear", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ sessions: [session("after-retry")], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionDiscovery(DEFAULT_SESSION_DISCOVERY_QUERY), {
      wrapper,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.loading).toBe(false);
    expect(result.current.sessions).toEqual([]);

    await act(() => result.current.retry());
    await waitFor(() =>
      expect(result.current.sessions.map((entry) => entry.id)).toEqual(["after-retry"])
    );
    expect(result.current.error).toBeUndefined();
  });
});
